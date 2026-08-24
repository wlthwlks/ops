import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  introductionRuns,
  introductionGroups,
  introductionGroupMembers,
  introductionDeliveries,
  cityIntroductionSettings,
  type IntroductionRun,
  type IntroductionGroup,
  type IntroductionGroupMember,
} from "@/db/schema";
import { getGlobalIntroductionConfig } from "./settings";
import { resolveEffectiveTemplate } from "./templates";
import { renderIntroductionEmail } from "./render-email";
import { loadMatchingOptionsCatalog } from "@/lib/forms/reference-data/matching-options-catalog";
import type { PlanMemberRegistryEntry } from "./plan";
import type { ScoreComponent } from "./profiles";

/**
 * Freeze / approve an introduction plan. Computing matches and sending email
 * are strictly separated: freezing renders every group email from immutable
 * template versions + plan snapshots, computes the plan hash, and creates
 * persistent per-recipient delivery jobs. Nothing here sends email, and a
 * later Airtable/Pinecone change can never mutate an approved run.
 */

export type DeliveryMode = "simulation" | "provider_test" | "canary" | "production";

export class FreezeError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "FreezeError";
  }
}

export interface FreezeOptions {
  runId: string;
  approvedBy?: string;
  deliveryMode?: DeliveryMode;
}

export interface FreezeResult {
  success: boolean;
  runId: string;
  planHash: string | null;
  deliveryMode: DeliveryMode;
  deliveryCount: number;
  templateVersionId: string | null;
  validationFailures: string[];
}

interface GroupWithMembers {
  group: IntroductionGroup;
  members: Array<IntroductionGroupMember & { snapshot: PlanMemberRegistryEntry | null }>;
}

export interface PlanHashInput {
  runId: string;
  cityCodesJson: string | null;
  cycleDate: string | null;
  deliveryMode: DeliveryMode;
  profileVersionId: string | null;
  templateVersionId: string | null;
  groups: Array<{
    fingerprint: string;
    members: string[];
  }>;
}

/** Deterministic canonical plan hash. */
export function computePlanHash(input: PlanHashInput): string {
  const canonical = {
    runId: input.runId,
    cityCodesJson: input.cityCodesJson,
    cycleDate: input.cycleDate,
    deliveryMode: input.deliveryMode,
    profileVersionId: input.profileVersionId,
    templateVersionId: input.templateVersionId,
    groups: [...input.groups]
      .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint))
      .map((g) => ({ fingerprint: g.fingerprint, members: [...g.members].sort() })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function deliveryKeyFor(groupId: string, email: string): string {
  return `group:${groupId}:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
}

interface DeliveryTargets {
  deliverTo: string;
  originalToJson: string | null;
}

function resolveTargets(
  mode: DeliveryMode,
  groupIndex: number,
  recipientEmail: string,
  originalEmails: string[],
  canaryEmails: string[],
  providerTestEmails: string[]
): { targets: DeliveryTargets; failure?: string } {
  switch (mode) {
    case "production":
    case "simulation":
      return { targets: { deliverTo: recipientEmail, originalToJson: null } };
    case "canary": {
      if (canaryEmails.length === 0) {
        return {
          targets: { deliverTo: recipientEmail, originalToJson: null },
          failure: "Canary delivery mode requires configured canary email addresses",
        };
      }
      return {
        targets: {
          deliverTo: canaryEmails[groupIndex % canaryEmails.length],
          originalToJson: JSON.stringify(originalEmails),
        },
      };
    }
    case "provider_test": {
      if (providerTestEmails.length === 0) {
        return {
          targets: { deliverTo: recipientEmail, originalToJson: null },
          failure: "Provider-test delivery mode requires configured provider-test email addresses",
        };
      }
      return {
        targets: {
          deliverTo: providerTestEmails[groupIndex % providerTestEmails.length],
          originalToJson: JSON.stringify(originalEmails),
        },
      };
    }
  }
}

function parseMemberSnapshot(member: IntroductionGroupMember): PlanMemberRegistryEntry | null {
  if (!member.memberSnapshotJson) return null;
  try {
    return JSON.parse(member.memberSnapshotJson) as PlanMemberRegistryEntry;
  } catch {
    return null;
  }
}

export async function freezeIntroductionRun(
  db: AppDb,
  options: FreezeOptions
): Promise<FreezeResult> {
  const runRows = await db
    .select()
    .from(introductionRuns)
    .where(eq(introductionRuns.id, options.runId))
    .limit(1);
  const run: IntroductionRun | undefined = runRows[0];
  if (!run) throw new FreezeError("PLAN_RUN_NOT_FOUND", `Run ${options.runId} not found`);
  if (run.status !== "planned") {
    throw new FreezeError(
      "PLAN_ALREADY_FROZEN",
      `Run ${options.runId} is already ${run.status} and cannot be re-approved`
    );
  }

  const validationFailures: string[] = [];
  const deliveryMode: DeliveryMode = options.deliveryMode ?? (run.deliveryMode as DeliveryMode);
  const global = await getGlobalIntroductionConfig(db);
  const template = await resolveEffectiveTemplate(db, run.emailTemplateVersionId);

  const groups = await db
    .select()
    .from(introductionGroups)
    .where(eq(introductionGroups.runId, options.runId));
  if (groups.length === 0) {
    throw new FreezeError("PLAN_HAS_NO_GROUPS", "The plan has no groups to approve");
  }

  const allMemberRows: IntroductionGroupMember[] = [];
  for (const group of groups) {
    const rows = await db
      .select()
      .from(introductionGroupMembers)
      .where(eq(introductionGroupMembers.groupId, group.id));
    allMemberRows.push(...rows);
  }

  const grouped: GroupWithMembers[] = groups.map((group) => ({
    group,
    members: allMemberRows
      .filter((m) => m.groupId === group.id)
      .map((m) => ({ ...m, snapshot: parseMemberSnapshot(m) })),
  }));

  const cycleDate = run.cycleDate ? run.cycleDate.slice(0, 10) : null;

  const planHashInput: PlanHashInput = {
    runId: run.id,
    cityCodesJson: run.cityCodesJson,
    cycleDate,
    deliveryMode,
    profileVersionId: run.matchingProfileVersionId,
    templateVersionId: template.versionId,
    groups: grouped.map(({ group, members }) => ({
      fingerprint: group.groupFingerprint,
      members: members.map((m) => m.emailSnapshot.trim().toLowerCase()).filter(Boolean),
    })),
  };
  const planHash = computePlanHash(planHashInput);

  // ─── Render group emails + create deliveries ───
  const cityName = grouped[0]?.group.cityName ?? "your city";

  // Meetup time comes from the city settings (default 10:00).
  let cityCode: string | null = null;
  try {
    cityCode = (JSON.parse(run.cityCodesJson ?? "[]") as string[])[0] ?? null;
  } catch {
    cityCode = null;
  }
  let meetupTime = "10:00";
  if (cityCode) {
    const cityRows = await db
      .select()
      .from(cityIntroductionSettings)
      .where(eq(cityIntroductionSettings.cityCode, cityCode))
      .limit(1);
    if (cityRows[0]?.meetupTime) meetupTime = cityRows[0].meetupTime;
  }

  let deliveryCount = 0;
  let groupIndex = 0;

  // Resolve help/expertise option record ids to display labels for the
  // member cards. Falls back to prettified codes when the catalog is
  // unavailable (e.g., missing env credentials).
  const catalog = await loadMatchingOptionsCatalog();
  const optionLabels = new Map<string, string>();
  for (const option of [...catalog.helpWantedOptions, ...catalog.expertiseOptions]) {
    if (option.code && option.label) optionLabels.set(option.code, option.label);
  }

  for (const { group, members } of grouped) {
    const originalEmails = members.map((m) => m.emailSnapshot);
    if (members.length === 0) {
      validationFailures.push(`Group ${group.id} has no members`);
      continue;
    }

    let scoreBreakdown: Partial<Record<ScoreComponent, number>> | null = null;
    if (group.scoreBreakdownJson) {
      try {
        scoreBreakdown = JSON.parse(group.scoreBreakdownJson) as Partial<Record<ScoreComponent, number>>;
      } catch {
        scoreBreakdown = null;
      }
    }

    const rendered = renderIntroductionEmail({
      subject: template.subject,
      bodyHtml: template.bodyHtml,
      cityName: cityName ?? "your city",
      introductionDate: cycleDate ?? "",
      meetupTime,
      members: members.map((m) => ({
        key: m.snapshot?.key ?? m.emailSnapshot,
        firstName: m.snapshot?.firstName ?? null,
        fullName: m.snapshot?.name ?? null,
        professionalHeadline: m.snapshot?.professionalHeadline ?? null,
        city: m.snapshot?.city ?? null,
        industry: m.snapshot?.industry ?? null,
        businessStage: m.snapshot?.businessStage ?? null,
        helpWanted: m.snapshot?.helpWanted ?? [],
        expertise: m.snapshot?.expertise ?? [],
        phone: m.snapshot?.phone ?? null,
        socialMedia: m.snapshot?.socialMedia ?? null,
        website: m.snapshot?.website ?? null,
      })),
      groupScoreBreakdown: scoreBreakdown,
      optionLabels,
    });

    await db
      .update(introductionGroups)
      .set({
        emailSubjectSnapshot: rendered.subject,
        emailHtmlSnapshot: rendered.html,
      })
      .where(eq(introductionGroups.id, group.id));

    for (const member of members) {
      const result = resolveTargets(
        deliveryMode,
        groupIndex,
        member.emailSnapshot,
        originalEmails,
        global.canaryEmails,
        global.providerTestEmails
      );
      if (result.failure) {
        validationFailures.push(result.failure);
        continue;
      }
      await db.insert(introductionDeliveries).values({
        id: crypto.randomUUID(),
        runId: run.id,
        groupId: group.id,
        recipientEmail: member.emailSnapshot,
        recipientName: member.snapshot?.name ?? null,
        airtableRecordId: member.airtableRecordId,
        originalToJson: result.targets.originalToJson,
        deliverToEmail: result.targets.deliverTo,
        deliveryKey: deliveryKeyFor(group.id, member.emailSnapshot),
        status: "pending",
        attemptCount: 0,
      });
      deliveryCount += 1;
    }
    groupIndex += 1;
  }

  if (validationFailures.length > 0) {
    return {
      success: false,
      runId: run.id,
      planHash: null,
      deliveryMode,
      deliveryCount: 0,
      templateVersionId: template.versionId,
      validationFailures,
    };
  }

  // ─── Freeze the run ───
  let snapshot: Record<string, unknown> = {};
  if (run.snapshotJson) {
    try {
      snapshot = JSON.parse(run.snapshotJson) as Record<string, unknown>;
    } catch {
      snapshot = {};
    }
  }
  snapshot.planHash = planHash;
  snapshot.deliveryMode = deliveryMode;
  snapshot.templateVersionId = template.versionId;
  snapshot.templateSubject = template.subject;
  snapshot.templateBodyHtml = template.bodyHtml;
  snapshot.frozenAt = new Date().toISOString();
  snapshot.approvedBy = options.approvedBy ?? null;

  await db
    .update(introductionRuns)
    .set({
      status: "approved",
      planHash,
      deliveryMode,
      emailTemplateVersionId: template.versionId,
      snapshotJson: JSON.stringify(snapshot),
      totalDeliveries: deliveryCount,
    })
    .where(eq(introductionRuns.id, run.id));

  // Frozen groups become claimable by the delivery worker. They stay
  // "planned" until this point so an edit or a failed freeze can never
  // leak a half-frozen group into the send queue.
  await db
    .update(introductionGroups)
    .set({ status: "approved", claimedAt: null, sendError: null })
    .where(eq(introductionGroups.runId, run.id));

  return {
    success: true,
    runId: run.id,
    planHash,
    deliveryMode,
    deliveryCount,
    templateVersionId: template.versionId,
    validationFailures,
  };
}
