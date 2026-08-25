import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  introductionRuns,
  introductionGroups,
  introductionGroupMembers,
  introductionPairScores,
  cityIntroductionSettings,
} from "@/db/schema";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import type { PineconeClient, VectorRecord } from "@/lib/integrations/pinecone";
import type {
  MatchingOption,
  MatchingOptionsCatalog,
} from "@/lib/forms/reference-data/matching-options-catalog";
import { loadMatchingOptionsCatalog } from "@/lib/forms/reference-data/matching-options-catalog";
import {
  BUSINESS_STAGES,
  CONNECTION_TYPES,
  INDUSTRIES,
} from "@/lib/forms/reference-data/static-options";
import { MEMBER_FIELDS, MEMBERS_TABLE, CITIES_TABLE } from "@/lib/ops/airtable-fields";
import {
  resolveEffectiveCitySettings,
  type EffectiveCitySettings,
} from "./settings";
import {
  checkMemberEligibility,
  checkPairEligibility,
  isValidEmail,
  memberKey,
  type MemberEligibilityReason,
} from "./member-eligibility";
import { loadPairHistory, type PairHistory } from "./pair-history";
import { cityAliasFilterFormula, canonicalizeCityName } from "./city-matching";
import { resolveMemberGeo, type ResolvedGeo } from "./geo-cache";
import { vectorIdsFor } from "./semantic-profile";
import { DEFAULT_SEMANTIC_NAMESPACE } from "@/lib/ops/sync-intro-profiles";
import {
  scorePair,
  type PairScoreBreakdown,
  type ScorableMember,
} from "./scoring";
import {
  PairScoreMatrix,
  buildGroups,
  type GroupingOptions,
} from "./grouping";
import { linkIdsFromField } from "@/lib/forms/reference-data/matching-options-catalog";

export const PLAN_MEMBER_FIELDS = [
  "email",
  "Name",
  "First Name",
  "Last Name",
  "City",
  "post code",
  "Membership",
  "Payment",
  "Service access until",
  "Recurring intro status",
  "Recurring pause until",
  "Stripe subscription status",
  "Industry",
  "Business stage",
  MEMBER_FIELDS.connectionType,
  MEMBER_FIELDS.professionalHeadline,
  MEMBER_FIELDS.profileBio,
  MEMBER_FIELDS.businessDescription,
  MEMBER_FIELDS.ninetyDayGoal,
  MEMBER_FIELDS.helpWanted,
  MEMBER_FIELDS.helpWantedContext,
  MEMBER_FIELDS.expertise,
  MEMBER_FIELDS.expertiseContext,
  MEMBER_FIELDS.phone,
  MEMBER_FIELDS.socialMedia,
  MEMBER_FIELDS.businessWebsite,
];

export interface PlanMember extends ScorableMember {
  airtableRecordId: string;
  name: string | null;
  firstName: string | null;
  professionalHeadline: string | null;
  phone: string | null;
  socialMedia: string | null;
  website: string | null;
  eligible: boolean;
  exclusionReason: MemberEligibilityReason | null;
}

export interface PlanMemberRegistryEntry {
  key: string;
  email: string;
  airtableRecordId: string;
  name: string | null;
  firstName: string | null;
  city: string | null;
  postcode: string | null;
  industry: string | null;
  businessStage: string | null;
  professionalHeadline: string | null;
  phone: string | null;
  socialMedia: string | null;
  website: string | null;
  helpWanted: string[];
  expertise: string[];
  connectionTypes: string[];
}

interface PlanSnapshot {
  seed: string;
  cycleId: string;
  cycleDate: string;
  profileVersionId: string | null;
  templateVersionId: string | null;
  blockedReason?: string | null;
  minEligibleMembers?: number | null;
  members: PlanMemberRegistryEntry[];
}

export function resolveCategoryCodes(
  linkedValue: unknown,
  catalogOptions: MatchingOption[]
): string[] {
  const codes = new Set(catalogOptions.map((o) => o.code));
  const resolved: string[] = [];
  for (const id of linkIdsFromField(linkedValue)) {
    if (codes.has(id)) {
      resolved.push(id);
      continue;
    }
    const normalized = id.toUpperCase().replace(/[\s-]+/g, "_");
    if (codes.has(normalized)) resolved.push(normalized);
  }
  return [...new Set(resolved)];
}

function codeFromValue(
  value: unknown,
  options: ReadonlyArray<{ code: string; label: string }>
): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  const byCode = options.find((o) => o.code === upper);
  if (byCode) return byCode.code;
  const byLabel = options.find((o) => o.label.toLowerCase() === raw.toLowerCase());
  if (byLabel) return byLabel.code;
  return upper.replace(/[\s/]+/g, "_");
}

function codeListFromValue(
  value: unknown,
  options: ReadonlyArray<{ code: string; label: string }>
): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => codeFromValue(typeof entry === "string" ? entry : "", options))
      .filter((code): code is string => Boolean(code));
  }
  const raw = String(value ?? "");
  return raw
    .split(",")
    .map((part) => codeFromValue(part, options))
    .filter((code): code is string => Boolean(code));
}

export function buildPlanMember(
  record: AirtableRecord,
  opts: {
    catalog: MatchingOptionsCatalog;
    vectors: Map<string, VectorRecord>;
    geo: ResolvedGeo;
  }
): PlanMember {
  const f = record.fields;
  const email = String(f["email"] ?? "").trim().toLowerCase();
  const name =
    String(f["Name"] ?? "").trim() ||
    `${String(f["First Name"] ?? "")} ${String(f["Last Name"] ?? "")}`.trim() ||
    null;
  const firstName = String(f["First Name"] ?? "").trim() || name?.split(" ")[0] || null;
  const vectorIds = vectorIdsFor(record.id);
  const helpWanted = resolveCategoryCodes(f[MEMBER_FIELDS.helpWanted], opts.catalog.helpWantedOptions);
  const expertise = resolveCategoryCodes(f[MEMBER_FIELDS.expertise], opts.catalog.expertiseOptions);

  return {
    key: memberKey(email, record.id),
    airtableRecordId: record.id,
    email,
    name,
    firstName,
    professionalHeadline: String(f[MEMBER_FIELDS.professionalHeadline] ?? "").trim() || null,
    phone: String(f[MEMBER_FIELDS.phone] ?? "").trim() || null,
    socialMedia: String(f[MEMBER_FIELDS.socialMedia] ?? "").trim() || null,
    website: String(f[MEMBER_FIELDS.businessWebsite] ?? "").trim() || null,
    city: canonicalizeCityName(String(f["City"] ?? "").trim()) || null,
    lat: opts.geo.lat,
    lon: opts.geo.lon,
    postcode: String(f["post code"] ?? "").trim() || null,
    industry: codeFromValue(f["Industry"], INDUSTRIES),
    businessStage: codeFromValue(f["Business stage"], BUSINESS_STAGES),
    connectionTypes: codeListFromValue(f[MEMBER_FIELDS.connectionType], CONNECTION_TYPES),
    helpWanted,
    helpWantedText:
      String(f[MEMBER_FIELDS.helpWantedContext] ?? "").trim() || null,
    expertise,
    expertiseText:
      String(f[MEMBER_FIELDS.expertiseContext] ?? "").trim() || null,
    goalText: String(f[MEMBER_FIELDS.ninetyDayGoal] ?? "").trim() || null,
    profileVector: opts.vectors.get(vectorIds.profile)?.values ?? null,
    helpVector: opts.vectors.get(vectorIds.help)?.values ?? null,
    expertiseVector: opts.vectors.get(vectorIds.expertise)?.values ?? null,
    goalVector: opts.vectors.get(vectorIds.goal)?.values ?? null,
    eligible: true,
    exclusionReason: null,
  };
}

export interface PlanMatrixResult {
  matrix: PairScoreMatrix;
  allowedPairs: number;
  repeatedPairsBlocked: number;
  cooldownBlocked: number;
  notSameCityBlocked: number;
  distanceBlocked: number;
}

const EMPTY_CYCLE = new Set<string>();

export function computePairMatrix(
  members: PlanMember[],
  opts: {
    cycleDate: Date;
    constraints: EffectiveCitySettings["constraints"];
    weights: EffectiveCitySettings["weights"];
    pairHistory: PairHistory;
    maxDistanceKm?: number | null;
  }
): PlanMatrixResult {
  const matrix = new PairScoreMatrix();
  let allowedPairs = 0;
  let repeatedPairsBlocked = 0;
  let cooldownBlocked = 0;
  let notSameCityBlocked = 0;
  let distanceBlocked = 0;

  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i];
      const b = members[j];
      const eligibility = checkPairEligibility(a, b, {
        cycleDate: opts.cycleDate,
        constraints: opts.constraints,
        pairHistory: opts.pairHistory,
        emailsInCycle: EMPTY_CYCLE,
      });
      if (!eligibility.eligible) {
        if (eligibility.reason === "recent_pair_repeat") repeatedPairsBlocked += 1;
        if (eligibility.reason === "member_cooldown") cooldownBlocked += 1;
        if (eligibility.reason === "not_same_city") notSameCityBlocked += 1;
        if (eligibility.reason === "distance_exceeds_max") distanceBlocked += 1;
        matrix.set(a.key, b.key, {
          score: { overall: 0, components: {} },
          allowed: false,
          blockedReason: eligibility.reason,
        });
        continue;
      }
      const score = scorePair(a, b, opts.weights, {
        maxDistanceKm: opts.maxDistanceKm,
      });
      matrix.set(a.key, b.key, { score, allowed: true });
      allowedPairs += 1;
    }
  }

  return {
    matrix,
    allowedPairs,
    repeatedPairsBlocked,
    cooldownBlocked,
    notSameCityBlocked,
    distanceBlocked,
  };
}

export interface IntroductionPlanDeps {
  db: AppDb;
  log: (message: string) => void;
  airtable: AirtableClient;
  pinecone: PineconeClient;
  now?: Date;
}

export interface IntroductionPreviewOptions {
  cityCode: string;
  /** YYYY-MM-DD; defaults to today (UTC). */
  cycleDate?: string;
  deliveryMode?: "simulation" | "provider_test" | "canary" | "production";
  createdBy?: string;
}

export interface IntroductionPreviewResult {
  success: boolean;
  error?: string;
  runId: string | null;
  cityCode: string;
  cityName: string | null;
  cycleId: string;
  cycleDate: string;
  seed: string;
  profileVersionId: string | null;
  deliveryMode: string;
  report: {
    eligibleMembers: number;
    matchedMembers: number;
    groups: number;
    unmatched: number;
    unmatchedMembers: Array<{ key: string; email: string; reason: string }>;
    excluded: Array<{ key: string; email: string; reason: string }>;
    repeatedPairsBlocked: number;
    invalidEmails: number;
    missingPostcode: number;
    allowedPairs: number;
    avgGroupScore: number | null;
    minGroupScore: number | null;
    renderedEmailCount: number;
    recipientCount: number;
    validationFailures: string[];
    minEligibleMembers: number;
    blockedReason: string | null;
  };
}

function toRegistryEntry(member: PlanMember): PlanMemberRegistryEntry {
  return {
    key: member.key,
    email: member.email,
    airtableRecordId: member.airtableRecordId,
    name: member.name,
    firstName: member.firstName,
    city: member.city,
    postcode: member.postcode,
    industry: member.industry,
    businessStage: member.businessStage,
    professionalHeadline: member.professionalHeadline,
    phone: member.phone,
    socialMedia: member.socialMedia,
    website: member.website,
    helpWanted: member.helpWanted,
    expertise: member.expertise,
    connectionTypes: member.connectionTypes,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await fn(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function resolveCityName(
  deps: IntroductionPlanDeps,
  cityCode: string,
  effective: EffectiveCitySettings
): Promise<string | null> {
  if (effective.cityName) return effective.cityName;
  try {
    const cityRecord = await deps.airtable.getRecord(CITIES_TABLE, cityCode);
    const f = cityRecord.fields;
    return (
      String(f["City"] ?? f["Name"] ?? f["name"] ?? "").trim() || null
    );
  } catch {
    return null;
  }
}

export async function runIntroductionPreview(
  deps: IntroductionPlanDeps,
  options: IntroductionPreviewOptions
): Promise<IntroductionPreviewResult> {
  const db = deps.db;
  const validationFailures: string[] = [];
  const cityCode = options.cityCode;

  const effective = await resolveEffectiveCitySettings(db, cityCode);
  const cityName = await resolveCityName(deps, cityCode, effective);
  if (!cityName) {
    validationFailures.push(`City ${cityCode} has no configured name`);
  }

  // Keep the city settings table in sync: previews auto-create the row for
  // a city that has never been synced (config overrides are untouched).
  if (cityName) {
    await db
      .insert(cityIntroductionSettings)
      .values({ id: crypto.randomUUID(), cityCode, cityName })
      .onConflictDoUpdate({
        target: cityIntroductionSettings.cityCode,
        set: { cityName, updatedAt: new Date() },
      });
  }

  const now = deps.now ?? new Date();
  const cycleDateStr =
    options.cycleDate ?? now.toISOString().slice(0, 10);
  const cycleDate = new Date(`${cycleDateStr}T00:00:00Z`);
  const cycleId = `intro-${cityCode}-${cycleDateStr}`;
  const seed = `${cycleId}|${effective.profileVersionId ?? "default"}|${cityCode}`;
  const deliveryMode = options.deliveryMode ?? "simulation";

  deps.log(`Loading pair history (pair ${effective.constraints.repeatPairDays}d, member ${effective.constraints.memberCooldownDays}d)...`);
  const pairHistory = await loadPairHistory(db, {
    pairDays: effective.constraints.repeatPairDays,
    memberDays: effective.constraints.memberCooldownDays,
  });

  const catalog = await loadMatchingOptionsCatalog(deps.airtable);

  deps.log(`Fetching members for ${cityName ?? cityCode}...`);
  const records = await deps.airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: cityAliasFilterFormula(cityName ?? cityCode),
    fields: PLAN_MEMBER_FIELDS,
  });
  deps.log(`Fetched ${records.length} member record(s)`);

  const namespace = process.env.INTRO_SEMANTIC_NAMESPACE ?? DEFAULT_SEMANTIC_NAMESPACE;

  // ─── Geo resolution (cached; Google only for changed/new locations) ───
  deps.log(`Resolving coordinates for ${records.length} member(s)...`);
  const geos = await mapWithConcurrency(records, 5, (record) =>
    resolveMemberGeo(db, {
      airtableRecordId: record.id,
      email: String(record.fields["email"] ?? ""),
      postcode: String(record.fields["post code"] ?? ""),
      city: String(record.fields["City"] ?? ""),
    })
  );
  const geoByRecordId = new Map<string, ResolvedGeo>();
  records.forEach((record, index) => geoByRecordId.set(record.id, geos[index]));

  // ─── Semantic vectors ───
  const vectorIds: string[] = [];
  for (const record of records) {
    const ids = vectorIdsFor(record.id);
    vectorIds.push(ids.profile, ids.help, ids.expertise, ids.goal);
  }
  deps.log(`Fetching ${vectorIds.length} vector(s) from namespace "${namespace}"...`);
  const vectors = await deps.pinecone.fetchByIds(vectorIds, namespace);
  deps.log(`Fetched ${vectors.size} vector(s)`);

  // ─── Build members & filter eligibility ───
  const recordById = new Map(records.map((record) => [record.id, record]));
  const built = records.map((record) =>
    buildPlanMember(record, {
      catalog,
      vectors,
      geo: geoByRecordId.get(record.id) ?? { lat: null, lon: null, displayName: null, source: "none", unknown: true },
    })
  );

  const eligible: PlanMember[] = [];
  const excluded: Array<{ key: string; email: string; reason: string }> = [];
  let invalidEmails = 0;
  for (const member of built) {
    const record = recordById.get(member.airtableRecordId);
    const f = record?.fields ?? {};
    const result = checkMemberEligibility(
      {
        airtableRecordId: member.airtableRecordId,
        email: member.email,
        membership: String(f["Membership"] ?? ""),
        payment: String(f["Payment"] ?? ""),
        serviceAccessUntil: String(f["Service access until"] ?? "") || null,
        stripeSubscriptionStatus: String(f["Stripe subscription status"] ?? "") || null,
        recurringIntroStatus: String(f["Recurring intro status"] ?? ""),
        recurringPauseUntil: String(f["Recurring pause until"] ?? "") || null,
        city: member.city,
        postcode: member.postcode,
        lat: member.lat,
        lon: member.lon,
      },
      { cycleDate, runCity: cityName, constraints: effective.constraints }
    );
    if (!isValidEmail(member.email)) invalidEmails += 1;
    if (!result.eligible) {
      member.eligible = false;
      member.exclusionReason = result.reason;
      excluded.push({ key: member.key, email: member.email, reason: result.reason ?? "unknown" });
      continue;
    }
    eligible.push(member);
  }
  deps.log(`Eligible: ${eligible.length}, excluded: ${excluded.length}`);

  // ─── Minimum-eligible-members city gate ───
  const minEligibleMembers = effective.constraints.minEligibleMembers;
  if (minEligibleMembers > 0 && eligible.length < minEligibleMembers) {
    const blockedReason = "insufficient_eligible_members";
    const runId = crypto.randomUUID();
    const snapshot: PlanSnapshot = {
      seed,
      cycleId,
      cycleDate: cycleDateStr,
      profileVersionId: effective.profileVersionId,
      templateVersionId: effective.emailTemplateVersionId,
      blockedReason,
      minEligibleMembers,
      members: eligible.map(toRegistryEntry),
    };
    await db.insert(introductionRuns).values({
      id: runId,
      requestId: runId,
      source: "city",
      cycleDate: cycleDateStr,
      mode: "preview",
      dryRun: true,
      status: "blocked",
      dueOnly: false,
      initiatedBy: options.createdBy ?? null,
      matchingProfileVersionId: effective.profileVersionId,
      emailTemplateVersionId: effective.emailTemplateVersionId,
      cityCodesJson: JSON.stringify([cityCode]),
      deliveryMode,
      snapshotJson: JSON.stringify(snapshot),
      createdByClerkUserId: options.createdBy ?? null,
      totalGroups: 0,
      summary: `${cityName ?? cityCode}: blocked — ${eligible.length} eligible member(s), minimum ${minEligibleMembers} required`,
    });
    deps.log(
      `City blocked: ${eligible.length} eligible member(s) < required ${minEligibleMembers}`
    );
    return {
      success: true,
      runId,
      cityCode,
      cityName,
      cycleId,
      cycleDate: cycleDateStr,
      seed,
      profileVersionId: effective.profileVersionId,
      deliveryMode,
      report: {
        eligibleMembers: eligible.length,
        matchedMembers: 0,
        groups: 0,
        unmatched: 0,
        unmatchedMembers: [],
        excluded,
        repeatedPairsBlocked: 0,
        invalidEmails,
        missingPostcode: eligible.filter((m) => !(m.postcode ?? "").trim()).length,
        allowedPairs: 0,
        avgGroupScore: null,
        minGroupScore: null,
        renderedEmailCount: 0,
        recipientCount: 0,
        validationFailures,
        minEligibleMembers,
        blockedReason,
      },
    };
  }

  // ─── Pair matrix ───
  const matrixResult = computePairMatrix(eligible, {
    cycleDate,
    constraints: effective.constraints,
    weights: effective.weights,
    pairHistory,
    maxDistanceKm: effective.constraints.maxDistanceKm,
  });
  deps.log(
    `Pair matrix: ${matrixResult.allowedPairs} allowed pair(s), ` +
      `${matrixResult.repeatedPairsBlocked} repeat-blocked, ${matrixResult.cooldownBlocked} cooldown-blocked, ` +
      `${matrixResult.notSameCityBlocked} not-same-city, ${matrixResult.distanceBlocked} distance-blocked`
  );

  // ─── Grouping ───
  const groupingOptions: GroupingOptions = {
    sizes: effective.groupSizes,
    seed,
    maxAttempts: 10,
  };
  const gs = effective.groupSizes;
  deps.log(
    `Grouping sizes: target ${gs.target}, min ${gs.min}, max ${gs.max}, strict ${gs.strict}`
  );
  const grouped = buildGroups(eligible, matrixResult.matrix, groupingOptions);
  deps.log(`Grouped: ${grouped.groups.length} group(s), ${grouped.unmatched.length} unmatched`);

  // ─── Persist run / pair scores / groups ───
  const runId = crypto.randomUUID();
  const missingPostcode = eligible.filter((m) => !(m.postcode ?? "").trim()).length;

  const snapshot: PlanSnapshot = {
    seed,
    cycleId,
    cycleDate: cycleDateStr,
    profileVersionId: effective.profileVersionId,
    templateVersionId: effective.emailTemplateVersionId,
    members: eligible.map(toRegistryEntry),
  };

  await db.insert(introductionRuns).values({
    id: runId,
    requestId: runId,
    source: "city",
    cycleDate: cycleDateStr,
    mode: "preview",
    dryRun: true,
    status: "planned",
    dueOnly: false,
    initiatedBy: options.createdBy ?? null,
    matchingProfileVersionId: effective.profileVersionId,
    emailTemplateVersionId: effective.emailTemplateVersionId,
    cityCodesJson: JSON.stringify([cityCode]),
    deliveryMode,
    snapshotJson: JSON.stringify(snapshot),
    createdByClerkUserId: options.createdBy ?? null,
    totalGroups: grouped.groups.length,
    summary: `${cityName ?? cityCode}: ${grouped.groups.length} groups, ${eligible.length} eligible (sizes ${effective.groupSizes.target}/${effective.groupSizes.min}/${effective.groupSizes.max}${effective.groupSizes.strict ? " strict" : ""})`,
  });

  const pairRows = matrixResult.matrix
    .entries()
    .filter(({ entry }) => entry.allowed)
    .map(({ keyA, keyB, entry }) => ({
      id: crypto.randomUUID(),
      runId,
      memberAKey: keyA,
      memberBKey: keyB,
      pairKey: `${keyA}|${keyB}`,
      scoresJson: JSON.stringify(entry.score),
      overall: entry.score.overall,
    }));
  for (let i = 0; i < pairRows.length; i += 1000) {
    await db.insert(introductionPairScores).values(pairRows.slice(i, i + 1000));
  }
  deps.log(`Persisted ${pairRows.length} pair score row(s)`);

  const groupScores = grouped.groupScores;
  for (let index = 0; index < grouped.groups.length; index++) {
    const groupMembers = grouped.groups[index];
    const groupScore = groupScores[index] ?? { overall: 0, components: {} };
    const groupId = crypto.randomUUID();
    const fingerprint = groupMembers
      .map((m) => m.key)
      .sort()
      .join("|");
    await db.insert(introductionGroups).values({
      id: groupId,
      runId,
      source: "city",
      cycleId,
      cityRecordId: cityCode,
      cityName,
      groupFingerprint: fingerprint,
      status: "planned",
      overallScore: groupScore.overall,
      scoreBreakdownJson: JSON.stringify(groupScore.components ?? {}),
      matchingProfileVersionId: effective.profileVersionId,
      cityCode,
      locked: false,
    });
    for (const member of groupMembers) {
      const registry = snapshot.members.find((m) => m.key === member.key);
      await db.insert(introductionGroupMembers).values({
        id: crypto.randomUUID(),
        groupId,
        airtableRecordId: registry?.airtableRecordId ?? null,
        emailSnapshot: registry?.email ?? "",
        role: "recurring",
        memberSnapshotJson: registry ? JSON.stringify(registry) : null,
      });
    }
  }
  deps.log(`Persisted ${grouped.groups.length} group(s)`);

  const matchedMembers = grouped.groups.flat().map((m) => m.key);
  const avgGroupScore =
    groupScores.length > 0
      ? groupScores.reduce((acc, s) => acc + s.overall, 0) / groupScores.length
      : null;
  const minGroupScore =
    groupScores.length > 0
      ? Math.min(...groupScores.map((s) => s.overall))
      : null;

  return {
    success: true,
    runId,
    cityCode,
    cityName,
    cycleId,
    cycleDate: cycleDateStr,
    seed,
    profileVersionId: effective.profileVersionId,
    deliveryMode,
    report: {
      eligibleMembers: eligible.length,
      matchedMembers: matchedMembers.length,
      groups: grouped.groups.length,
      unmatched: grouped.unmatched.length,
      unmatchedMembers: grouped.unmatched.map((u) => ({
        key: u.key,
        email: eligible.find((m) => m.key === u.key)?.email ?? "",
        reason: u.reason,
      })),
      excluded,
      repeatedPairsBlocked: matrixResult.repeatedPairsBlocked,
      invalidEmails,
      missingPostcode,
      allowedPairs: matrixResult.allowedPairs,
      avgGroupScore: avgGroupScore === null ? null : Math.round(avgGroupScore * 10000) / 10000,
      minGroupScore: minGroupScore === null ? null : Math.round(minGroupScore * 10000) / 10000,
      renderedEmailCount: grouped.groups.length,
      recipientCount: matchedMembers.length,
      validationFailures,
      minEligibleMembers,
      blockedReason: null,
    },
  };
}

export class PlanEditError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PlanEditError";
  }
}

export type PlanEdit =
  | { type: "remove_member"; groupId: string; memberKey: string }
  | { type: "replace_member"; groupId: string; memberKey: string; replacementKey: string }
  | { type: "regenerate_group"; groupId: string }
  | { type: "lock_group"; groupId: string; locked: boolean }
  | { type: "regenerate_city" };

function parseSnapshot(run: { snapshotJson: string | null }): PlanSnapshot {
  if (!run.snapshotJson) {
    throw new PlanEditError("PLAN_SNAPSHOT_MISSING", "This run has no plan snapshot");
  }
  try {
    return JSON.parse(run.snapshotJson) as PlanSnapshot;
  } catch {
    throw new PlanEditError("PLAN_SNAPSHOT_MISSING", "This run's plan snapshot is unreadable");
  }
}

async function loadRunForEdit(db: AppDb, runId: string) {
  const rows = await db
    .select()
    .from(introductionRuns)
    .where(eq(introductionRuns.id, runId))
    .limit(1);
  const run = rows[0];
  if (!run) throw new PlanEditError("PLAN_RUN_NOT_FOUND", `Run ${runId} not found`);
  if (run.status !== "planned") {
    throw new PlanEditError("PLAN_FROZEN", "The plan is frozen and can no longer be edited");
  }
  return run;
}

async function assertGroupEditable(db: AppDb, groupId: string): Promise<void> {
  const rows = await db
    .select()
    .from(introductionGroups)
    .where(eq(introductionGroups.id, groupId))
    .limit(1);
  const group = rows[0];
  if (!group) throw new PlanEditError("PLAN_GROUP_NOT_FOUND", `Group ${groupId} not found`);
  if (group.locked) {
    throw new PlanEditError("PLAN_GROUP_LOCKED", "This group is locked and cannot be edited");
  }
}

async function deletePairScoresForMember(db: AppDb, runId: string, memberKey: string): Promise<void> {
  await db
    .delete(introductionPairScores)
    .where(
      and(
        eq(introductionPairScores.runId, runId),
        or(
          eq(introductionPairScores.memberAKey, memberKey),
          eq(introductionPairScores.memberBKey, memberKey)
        )
      )
    );
}

async function rebuildCityPlan(db: AppDb, runId: string): Promise<void> {
  const run = await loadRunForEdit(db, runId);
  const snapshot = parseSnapshot(run);
  const cityCode = JSON.parse(run.cityCodesJson ?? "[]")[0] as string | undefined;
  if (!cityCode) throw new PlanEditError("PLAN_CITY_MISSING", "Run has no city code");

  const effective = await resolveEffectiveCitySettings(db, cityCode);

  const pairRows = await db
    .select()
    .from(introductionPairScores)
    .where(eq(introductionPairScores.runId, runId));
  const matrix = new PairScoreMatrix();
  for (const row of pairRows) {
    let score: PairScoreBreakdown = { overall: row.overall, components: {} };
    try {
      const parsed = JSON.parse(row.scoresJson) as Partial<PairScoreBreakdown>;
      score = {
        overall: row.overall,
        components: (parsed.components ?? {}) as PairScoreBreakdown["components"],
      };
    } catch {
      // keep the overall-only fallback
    }
    matrix.set(row.memberAKey, row.memberBKey, { score, allowed: true });
  }

  const poolKeys = new Set<string>();
  for (const row of pairRows) {
    poolKeys.add(row.memberAKey);
    poolKeys.add(row.memberBKey);
  }
  const poolMembers = snapshot.members.filter((m) => poolKeys.has(m.key));
  const registryByKey = new Map(snapshot.members.map((m) => [m.key, m]));

  const lockedRows = await db
    .select()
    .from(introductionGroups)
    .where(and(eq(introductionGroups.runId, runId), eq(introductionGroups.locked, true)));
  const lockedGroups: Array<Array<{ key: string }>> = [];
  for (const locked of lockedRows) {
    const memberRows = await db
      .select()
      .from(introductionGroupMembers)
      .where(eq(introductionGroupMembers.groupId, locked.id));
    lockedGroups.push(memberRows.map((m) => ({ key: memberKey(m.emailSnapshot, m.airtableRecordId) })));
  }
  const lockedKeys = new Set(lockedGroups.flat().map((m) => m.key));
  const freePool = poolMembers.filter((m) => !lockedKeys.has(m.key));

  // Rebuild only the free members; locked groups stay untouched.
  const result = buildGroups(freePool, matrix, {
    sizes: effective.groupSizes,
    seed: snapshot.seed,
    maxAttempts: 10,
  });

  await db
    .delete(introductionGroups)
    .where(and(eq(introductionGroups.runId, runId), eq(introductionGroups.locked, false)));

  for (let index = 0; index < result.groups.length; index++) {
    const groupMembers = result.groups[index];
    const groupScore = result.groupScores[index] ?? { overall: 0, components: {} };
    const groupId = crypto.randomUUID();
    await db.insert(introductionGroups).values({
      id: groupId,
      runId,
      source: "city",
      cycleId: snapshot.cycleId,
      cityRecordId: cityCode,
      cityName: null,
      groupFingerprint: groupMembers.map((m) => m.key).sort().join("|"),
      status: "planned",
      overallScore: groupScore.overall,
      scoreBreakdownJson: JSON.stringify(groupScore.components ?? {}),
      matchingProfileVersionId: snapshot.profileVersionId,
      cityCode,
      locked: false,
    });
    for (const member of groupMembers) {
      const registry = registryByKey.get(member.key);
      await db.insert(introductionGroupMembers).values({
        id: crypto.randomUUID(),
        groupId,
        airtableRecordId: registry?.airtableRecordId ?? null,
        emailSnapshot: registry?.email ?? "",
        role: "recurring",
        memberSnapshotJson: registry ? JSON.stringify(registry) : null,
      });
    }
  }

  await db
    .update(introductionRuns)
    .set({ totalGroups: lockedRows.length + result.groups.length })
    .where(eq(introductionRuns.id, runId));
}

export async function applyPlanEdit(
  db: AppDb,
  runId: string,
  edit: PlanEdit
): Promise<{ success: boolean; summary: string }> {
  await loadRunForEdit(db, runId);

  switch (edit.type) {
    case "lock_group": {
      const rows = await db
        .select()
        .from(introductionGroups)
        .where(eq(introductionGroups.id, edit.groupId))
        .limit(1);
      if (!rows[0]) throw new PlanEditError("PLAN_GROUP_NOT_FOUND", `Group ${edit.groupId} not found`);
      await db
        .update(introductionGroups)
        .set({ locked: edit.locked })
        .where(eq(introductionGroups.id, edit.groupId));
      return { success: true, summary: `Group ${edit.locked ? "locked" : "unlocked"}` };
    }
    case "remove_member": {
      await assertGroupEditable(db, edit.groupId);
      await db
        .delete(introductionGroupMembers)
        .where(
          and(
            eq(introductionGroupMembers.groupId, edit.groupId),
            or(
              eq(introductionGroupMembers.airtableRecordId, edit.memberKey.replace(/^at:/, "")),
              eq(introductionGroupMembers.emailSnapshot, edit.memberKey.replace(/^em:/, ""))
            )
          )
        );
      await deletePairScoresForMember(db, runId, edit.memberKey);
      await rebuildCityPlan(db, runId);
      return { success: true, summary: `Removed member ${edit.memberKey}` };
    }
    case "replace_member": {
      await assertGroupEditable(db, edit.groupId);
      const run = await loadRunForEdit(db, runId);
      const snapshot = parseSnapshot(run);
      const replacement = snapshot.members.find((m) => m.key === edit.replacementKey);
      if (!replacement) {
        throw new PlanEditError("REPLACEMENT_NOT_FOUND", `Member ${edit.replacementKey} is not part of this plan`);
      }
      const replacementPairs = await db
        .select()
        .from(introductionPairScores)
        .where(
          and(
            eq(introductionPairScores.runId, runId),
            or(
              eq(introductionPairScores.memberAKey, edit.replacementKey),
              eq(introductionPairScores.memberBKey, edit.replacementKey)
            )
          )
        )
        .limit(1);
      if (replacementPairs.length === 0) {
        throw new PlanEditError("REPLACEMENT_NOT_AVAILABLE", `Member ${edit.replacementKey} has no eligible pairs`);
      }
      await db
        .delete(introductionGroupMembers)
        .where(
          and(
            eq(introductionGroupMembers.groupId, edit.groupId),
            or(
              eq(introductionGroupMembers.airtableRecordId, edit.memberKey.replace(/^at:/, "")),
              eq(introductionGroupMembers.emailSnapshot, edit.memberKey.replace(/^em:/, ""))
            )
          )
        );
      await deletePairScoresForMember(db, runId, edit.memberKey);
      await rebuildCityPlan(db, runId);
      return { success: true, summary: `Replaced ${edit.memberKey} with ${edit.replacementKey}` };
    }
    case "regenerate_group": {
      await assertGroupEditable(db, edit.groupId);
      await db.delete(introductionGroups).where(eq(introductionGroups.id, edit.groupId));
      await rebuildCityPlan(db, runId);
      return { success: true, summary: `Regenerated group ${edit.groupId}` };
    }
    case "regenerate_city": {
      await rebuildCityPlan(db, runId);
      return { success: true, summary: "Regenerated city plan" };
    }
  }
}

export async function listIntroductionRuns(db: AppDb, limit = 20) {
  return db
    .select()
    .from(introductionRuns)
    .orderBy(desc(introductionRuns.createdAt))
    .limit(limit);
}

export async function getRunDetail(db: AppDb, runId: string) {
  const runRows = await db
    .select()
    .from(introductionRuns)
    .where(eq(introductionRuns.id, runId))
    .limit(1);
  const run = runRows[0] ?? null;
  if (!run) return null;

  const groups = await db
    .select()
    .from(introductionGroups)
    .where(eq(introductionGroups.runId, runId))
    .orderBy(introductionGroups.createdAt);
  const memberRows = await db
    .select()
    .from(introductionGroupMembers)
    .where(
      inArray(
        introductionGroupMembers.groupId,
        groups.map((g) => g.id)
      )
    );

  const membersByGroup = new Map<string, typeof memberRows>();
  for (const row of memberRows) {
    const list = membersByGroup.get(row.groupId) ?? [];
    list.push(row);
    membersByGroup.set(row.groupId, list);
  }

  return {
    run,
    groups: groups.map((group) => ({
      id: group.id,
      locked: group.locked,
      status: group.status,
      cityName: group.cityName,
      overallScore: group.overallScore,
      scoreBreakdown: group.scoreBreakdownJson ? JSON.parse(group.scoreBreakdownJson) : null,
      emailSubjectSnapshot: group.emailSubjectSnapshot,
      emailHtmlSnapshot: group.emailHtmlSnapshot,
      members: (membersByGroup.get(group.id) ?? []).map((m) => {
        let snapshot: PlanMemberRegistryEntry | null = null;
        if (m.memberSnapshotJson) {
          try {
            snapshot = JSON.parse(m.memberSnapshotJson) as PlanMemberRegistryEntry;
          } catch {
            snapshot = null;
          }
        }
        return {
          id: m.id,
          key: memberKey(m.emailSnapshot, m.airtableRecordId),
          email: m.emailSnapshot,
          airtableRecordId: m.airtableRecordId,
          name: snapshot?.name ?? null,
          firstName: snapshot?.firstName ?? null,
          professionalHeadline: snapshot?.professionalHeadline ?? null,
          phone: snapshot?.phone ?? null,
          socialMedia: snapshot?.socialMedia ?? null,
          website: snapshot?.website ?? null,
          city: snapshot?.city ?? null,
          postcode: snapshot?.postcode ?? null,
          industry: snapshot?.industry ?? null,
          businessStage: snapshot?.businessStage ?? null,
          helpWanted: snapshot?.helpWanted ?? [],
          expertise: snapshot?.expertise ?? [],
        };
      }),
    })),
  };
}

export async function getAlternativesForMember(
  db: AppDb,
  runId: string,
  memberKey: string,
  limit = 5
): Promise<Array<{ key: string; overall: number; breakdown: PairScoreBreakdown["components"] }>> {
  const rows = await db
    .select()
    .from(introductionPairScores)
    .where(
      and(
        eq(introductionPairScores.runId, runId),
        or(
          eq(introductionPairScores.memberAKey, memberKey),
          eq(introductionPairScores.memberBKey, memberKey)
        )
      )
    )
    .orderBy(desc(introductionPairScores.overall))
    .limit(limit);

  return rows.map((row) => {
    let components: PairScoreBreakdown["components"] = {};
    try {
      const parsed = JSON.parse(row.scoresJson) as Partial<PairScoreBreakdown>;
      components = (parsed.components ?? {}) as PairScoreBreakdown["components"];
    } catch {
      components = {};
    }
    const other = row.memberAKey === memberKey ? row.memberBKey : row.memberAKey;
    return { key: other, overall: row.overall, breakdown: components };
  });
}
