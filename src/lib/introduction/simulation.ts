import { eq, inArray } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  introductionDeliveries,
  introductionDeliveryEvents,
  introductionGroups,
  introductionGroupMembers,
  introductionPairScores,
  introductionRuns,
} from "@/db/schema";
import { isValidEmail } from "./member-eligibility";
import { DEFAULT_BATCH_SIZE } from "./delivery-queue";
import { resolveEffectiveCitySettings } from "./settings";

/**
 * Full-simulation reporting for introduction runs. Pure database reads —
 * this module never sends anything and never calls an external provider.
 * Used to prove out a plan before any delivery mode is chosen.
 */

export interface QueueSizeEstimate {
  groupCount: number;
  deliveryCount: number;
  batchSize: number;
  /** Number of provider batch requests needed. */
  batches: number;
  /** Number of worker ticks needed at the configured batch size. */
  workerTicks: number;
}

export function estimateQueueSizes(
  groupCount: number,
  deliveryCount: number,
  batchSize: number = DEFAULT_BATCH_SIZE
): QueueSizeEstimate {
  const safeBatch = batchSize > 0 ? batchSize : DEFAULT_BATCH_SIZE;
  const batches = groupCount === 0 ? 0 : Math.ceil(groupCount / safeBatch);
  return {
    groupCount,
    deliveryCount,
    batchSize: safeBatch,
    batches,
    workerTicks: batches,
  };
}

export interface DeliveryModeSafety {
  level: "none" | "internal" | "production";
  label: string;
  description: string;
}

export function deliveryModeSafety(mode: string | null | undefined): DeliveryModeSafety {
  switch (mode) {
    case "production":
      return {
        level: "production",
        label: "Production",
        description:
          "Emails go to real members. Requires live mode plus typed confirmation.",
      };
    case "canary":
      return {
        level: "internal",
        label: "Canary",
        description:
          "Emails are redirected to approved internal addresses; original recipients are recorded but not emailed.",
      };
    case "provider_test":
      return {
        level: "internal",
        label: "Provider test",
        description:
          "Emails go to provider-test addresses to exercise delivered/bounced/failed webhook paths.",
      };
    default:
      return {
        level: "none",
        label: "Simulation",
        description: "No email is ever sent; the plan is rendered and validated only.",
      };
  }
}

export interface SimulationReport {
  runId: string;
  status: string;
  deliveryMode: string;
  safety: DeliveryModeSafety;
  groups: number;
  deliveries: number;
  eligibleMembers: number;
  matchedMembers: number;
  unmatchedMembers: number;
  unmatchedMemberDetails: Array<{ email: string; reason: string }>;
  duplicateMembers: string[];
  repeatedPairsBlocked: number | null;
  invalidEmails: string[];
  renderedEmails: number;
  recipientCount: number;
  canaryRedirectCount: number;
  queue: QueueSizeEstimate;
  validationFailures: string[];
  minEligibleMembers: number;
  blockedReason: string | null;
  /** Effective group sizes for the run's city, resolved at report time. */
  groupSizes: { target: number; min: number; max: number; strict: boolean } | null;
}

export async function buildSimulationReport(
  db: AppDb,
  runId: string
): Promise<SimulationReport | null> {
  const runRows = await db
    .select()
    .from(introductionRuns)
    .where(eq(introductionRuns.id, runId))
    .limit(1);
  const run = runRows[0];
  if (!run) return null;

  const groups = await db
    .select()
    .from(introductionGroups)
    .where(eq(introductionGroups.runId, runId));
  const groupIds = groups.map((g) => g.id);
  const memberRows = groupIds.length
    ? await db
        .select()
        .from(introductionGroupMembers)
        .where(inArray(introductionGroupMembers.groupId, groupIds))
    : [];
  const deliveries = await db
    .select()
    .from(introductionDeliveries)
    .where(eq(introductionDeliveries.runId, runId));

  let snapshotMembers: Array<{ key: string; email: string }> = [];
  let snapshotBlockedReason: string | null = null;
  let snapshotMinEligibleMembers = 0;
  if (run.snapshotJson) {
    try {
      const snapshot = JSON.parse(run.snapshotJson) as {
        members?: Array<{ key: string; email: string }>;
        blockedReason?: string | null;
        minEligibleMembers?: number | null;
      };
      snapshotMembers = snapshot.members ?? [];
      snapshotBlockedReason = snapshot.blockedReason ?? null;
      snapshotMinEligibleMembers = snapshot.minEligibleMembers ?? 0;
    } catch {
      snapshotMembers = [];
    }
  }

  const memberKeysInGroups = new Set(memberRows.map((m) => m.emailSnapshot.trim().toLowerCase()));
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const email of memberKeysInGroups) {
    if (seen.has(email)) duplicates.push(email);
    seen.add(email);
  }

  const invalidEmails: string[] = [];
  for (const delivery of deliveries) {
    if (!isValidEmail(delivery.deliverToEmail)) invalidEmails.push(delivery.deliverToEmail);
  }

  const renderedEmails = groups.filter((g) => g.emailSubjectSnapshot && g.emailHtmlSnapshot).length;
  const canaryRedirectCount = deliveries.filter(
    (d) => d.deliverToEmail.trim().toLowerCase() !== d.recipientEmail.trim().toLowerCase()
  ).length;

  const matchedKeys = new Set(memberRows.map((m) => m.emailSnapshot.trim().toLowerCase()));
  const unmatched = snapshotMembers.filter((m) => !matchedKeys.has(m.email.trim().toLowerCase()));

  // Reason per unmatched member: no pair-score rows at all means every pair
  // was blocked by a hard constraint; otherwise it's a size leftover.
  const pairScoreRows = await db
    .select({
      memberAKey: introductionPairScores.memberAKey,
      memberBKey: introductionPairScores.memberBKey,
    })
    .from(introductionPairScores)
    .where(eq(introductionPairScores.runId, runId));
  const keysWithPairs = new Set<string>();
  for (const row of pairScoreRows) {
    keysWithPairs.add(row.memberAKey);
    keysWithPairs.add(row.memberBKey);
  }
  const unmatchedMemberDetails = unmatched.map((member) => ({
    email: member.email,
    reason: keysWithPairs.has(member.key) ? "size_impossible" : "no_allowed_pairs",
  }));

  const validationFailures: string[] = [];
  if (invalidEmails.length > 0) {
    validationFailures.push(`${invalidEmails.length} recipient(s) with invalid deliver-to email`);
  }
  if (duplicates.length > 0) {
    validationFailures.push(`${duplicates.length} member(s) appear in more than one group`);
  }

  // Effective group sizes for the run's city (best-effort; current config,
  // which may differ from the config at plan time).
  let groupSizes: SimulationReport["groupSizes"] = null;
  try {
    const cityCodes = JSON.parse(run.cityCodesJson ?? "[]") as unknown;
    const first = Array.isArray(cityCodes) && typeof cityCodes[0] === "string" ? cityCodes[0] : null;
    if (first) {
      const effective = await resolveEffectiveCitySettings(db, first);
      groupSizes = {
        target: effective.groupSizes.target,
        min: effective.groupSizes.min,
        max: effective.groupSizes.max,
        strict: effective.groupSizes.strict,
      };
    }
  } catch {
    groupSizes = null;
  }

  return {
    runId,
    status: run.status,
    deliveryMode: run.deliveryMode,
    safety: deliveryModeSafety(run.deliveryMode),
    groups: groups.length,
    deliveries: deliveries.length,
    eligibleMembers: snapshotMembers.length,
    matchedMembers: matchedKeys.size,
    unmatchedMembers: unmatched.length,
    unmatchedMemberDetails,
    duplicateMembers: duplicates,
    repeatedPairsBlocked: null,
    invalidEmails,
    renderedEmails,
    recipientCount: deliveries.length,
    canaryRedirectCount,
    queue: estimateQueueSizes(groups.length, deliveries.length),
    validationFailures,
    minEligibleMembers: snapshotMinEligibleMembers,
    blockedReason: snapshotBlockedReason,
    groupSizes,
  };
}

export interface RunDeliveryRow {
  id: string;
  runId: string;
  groupId: string;
  recipientEmail: string;
  recipientName: string | null;
  deliverToEmail: string;
  originalTo: string[] | null;
  status: string;
  resendMessageId: string | null;
  attemptCount: number;
  nextRetryAt: Date | null;
  lastEventAt: Date | null;
  error: string | null;
  sentAt: Date | null;
}

export async function listRunDeliveries(db: AppDb, runId: string): Promise<RunDeliveryRow[]> {
  const rows = await db
    .select()
    .from(introductionDeliveries)
    .where(eq(introductionDeliveries.runId, runId))
    .orderBy(introductionDeliveries.createdAt);

  return rows.map((row) => {
    let originalTo: string[] | null = null;
    if (row.originalToJson) {
      try {
        const parsed = JSON.parse(row.originalToJson) as unknown;
        if (Array.isArray(parsed)) originalTo = parsed.map(String);
      } catch {
        originalTo = null;
      }
    }
    return {
      id: row.id,
      runId: row.runId,
      groupId: row.groupId,
      recipientEmail: row.recipientEmail,
      recipientName: row.recipientName,
      deliverToEmail: row.deliverToEmail,
      originalTo,
      status: row.status,
      resendMessageId: row.resendMessageId,
      attemptCount: row.attemptCount,
      nextRetryAt: row.nextRetryAt,
      lastEventAt: row.lastEventAt,
      error: row.error,
      sentAt: row.sentAt,
    };
  });
}

/** Provider events for every delivery of a run (deliveryId-keyed). */
export async function listRunDeliveryEvents(db: AppDb, runId: string) {
  const deliveries = await db
    .select({ id: introductionDeliveries.id })
    .from(introductionDeliveries)
    .where(eq(introductionDeliveries.runId, runId));
  const ids = deliveries.map((d) => d.id);
  if (ids.length === 0) return [];
  return db
    .select()
    .from(introductionDeliveryEvents)
    .where(inArray(introductionDeliveryEvents.deliveryId, ids))
    .orderBy(introductionDeliveryEvents.providerTs);
}
