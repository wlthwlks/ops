/**
 * Individual (manual) introduction matching.
 *
 * An operator provides an email; the engine finds that member regardless of
 * membership state (paused / cancelled / no access), re-syncs their semantic
 * profile, and matches them with the two best-fitting ACTIVE members from
 * their own city using the SAME matching profile (weights + constraints) as
 * the monthly engine. The 180-day repeat-pair rule still applies to everyone.
 */
import type { AppDb } from "@/db";
import {
  introductionRuns,
  introductionGroups,
  introductionGroupMembers,
  introductionPairScores,
} from "@/db/schema";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import type { PineconeClient, VectorRecord } from "@/lib/integrations/pinecone";
import { MEMBER_FIELDS, MEMBERS_TABLE, CITIES_TABLE } from "@/lib/ops/airtable-fields";
import { resolveEffectiveCitySettings, type EffectiveCitySettings } from "./settings";
import { checkMemberEligibility } from "./member-eligibility";
import { loadPairHistory } from "./pair-history";
import {
  loadMatchingOptionsCatalog,
  linkIdsFromField,
} from "@/lib/forms/reference-data/matching-options-catalog";
import { resolveMemberGeo, type ResolvedGeo } from "./geo-cache";
import { vectorIdsFor } from "./semantic-profile";
import { DEFAULT_SEMANTIC_NAMESPACE } from "@/lib/ops/sync-intro-profiles";
import type { PairScoreBreakdown } from "./scoring";
import type { ScoreComponent } from "./profiles";
import {
  buildPlanMember,
  computePairMatrix,
  fetchCityMemberRecords,
  toRegistryEntry,
  PLAN_MEMBER_FIELDS,
  type PlanMember,
} from "./plan";
import { syncMemberSemanticProfile } from "./member-profile-sync";
import { ensureIndividualTemplate, resolveIndividualTemplate } from "./templates";
import { freezeIntroductionRun, type DeliveryMode } from "./freeze";
import { PairScoreMatrix } from "./grouping";

export interface IndividualMatchDeps {
  db: AppDb;
  log: (message: string) => void;
  airtable: AirtableClient;
  pinecone: PineconeClient;
  now?: Date;
}

export interface IndividualPartnerInfo {
  key: string;
  email: string;
  name: string | null;
  professionalHeadline: string | null;
  city: string | null;
  industry: string | null;
  businessStage: string | null;
}

export interface IndividualMatchProposal {
  success: boolean;
  code?: string;
  error?: string;
  target: IndividualPartnerInfo | null;
  partners: IndividualPartnerInfo[];
  groupScore: number | null;
  groupScoreBreakdown: Partial<Record<ScoreComponent, number>> | null;
  cityCode: string | null;
  cityName: string | null;
  eligiblePoolSize: number;
}

function toPartnerInfo(member: PlanMember): IndividualPartnerInfo {
  return {
    key: member.key,
    email: member.email,
    name: member.name,
    professionalHeadline: member.professionalHeadline,
    city: member.city,
    industry: member.industry,
    businessStage: member.businessStage,
  };
}

async function resolveCityName(airtable: AirtableClient, cityCode: string): Promise<string | null> {
  try {
    const record = await airtable.getRecord(CITIES_TABLE, cityCode);
    const f = record.fields;
    return String(f["City"] ?? f["Name"] ?? f["name"] ?? "").trim() || null;
  } catch {
    return null;
  }
}

function namespace(): string {
  return process.env.INTRO_SEMANTIC_NAMESPACE ?? DEFAULT_SEMANTIC_NAMESPACE;
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

export function combineBreakdowns(
  breakdowns: PairScoreBreakdown[]
): Partial<Record<ScoreComponent, number>> {
  const totals: Partial<Record<ScoreComponent, number>> = {};
  let pairCount = 0;
  for (const b of breakdowns) {
    for (const [component, value] of Object.entries(b.components)) {
      const key = component as ScoreComponent;
      totals[key] = (totals[key] ?? 0) + (value ?? 0);
    }
    pairCount += 1;
  }
  if (pairCount === 0) return {};
  const result: Partial<Record<ScoreComponent, number>> = {};
  for (const [key, sum] of Object.entries(totals)) {
    result[key as ScoreComponent] =
      Math.round(((sum ?? 0) / pairCount) * 1_000_000) / 1_000_000;
  }
  return result;
}

export interface SelectedPartners {
  partners: [PlanMember, PlanMember];
  groupScore: number;
  breakdowns: PairScoreBreakdown[];
}

/**
 * Pick the two partners that maximize the group score (mean of the three
 * intra-group pair scores), subject to every pair being allowed by the hard
 * constraints (same-city, repeat-pair, cooldown, distance). Returns null when
 * no valid pair exists.
 */
export function selectBestPartners(
  target: PlanMember,
  partners: PlanMember[],
  matrix: PairScoreMatrix
): SelectedPartners | null {
  let best: SelectedPartners | null = null;

  for (let i = 0; i < partners.length; i++) {
    for (let j = i + 1; j < partners.length; j++) {
      const a = matrix.get(target.key, partners[i].key);
      const b = matrix.get(target.key, partners[j].key);
      const c = matrix.get(partners[i].key, partners[j].key);
      if (!a?.allowed || !b?.allowed || !c?.allowed) continue;
      const groupScore = (a.score.overall + b.score.overall + c.score.overall) / 3;
      if (!best || groupScore > best.groupScore) {
        best = {
          partners: [partners[i], partners[j]],
          groupScore,
          breakdowns: [a.score, b.score, c.score],
        };
      }
    }
  }

  return best;
}

interface ResolvedProposal {
  proposal: IndividualMatchProposal;
  target: PlanMember | null;
  partners: PlanMember[];
  effective: EffectiveCitySettings | null;
  targetRecord: AirtableRecord | null;
  cycleDate: string;
}

async function resolveProposal(
  deps: IndividualMatchDeps,
  targetEmail: string
): Promise<ResolvedProposal> {
  const { db, airtable, pinecone, log } = deps;
  const now = deps.now ?? new Date();
  const cycleDate = now.toISOString().slice(0, 10);
  const cycleDateObj = new Date(`${cycleDate}T00:00:00Z`);

  const fail = (code: string, error: string): ResolvedProposal => ({
    proposal: {
      success: false,
      code,
      error,
      target: null,
      partners: [],
      groupScore: null,
      groupScoreBreakdown: null,
      cityCode: null,
      cityName: null,
      eligiblePoolSize: 0,
    },
    target: null,
    partners: [],
    effective: null,
    targetRecord: null,
    cycleDate,
  });

  // ── Resolve the target member by email ──
  const normalizedEmail = targetEmail.trim().toLowerCase();
  const escaped = normalizedEmail.replace(/"/g, '\\"');
  let targetRecord: AirtableRecord;
  try {
    const records = await airtable.listRecords(MEMBERS_TABLE, {
      filterByFormula: `LOWER({email}) = "${escaped}"`,
      fields: [...PLAN_MEMBER_FIELDS],
    });
    if (records.length === 0) {
      return fail("TARGET_NOT_FOUND", `No member found with email ${targetEmail}`);
    }
    targetRecord = records[0];
  } catch (err) {
    return fail("AIRTABLE_ERROR", err instanceof Error ? err.message : String(err));
  }

  const targetEmailNormalized = String(targetRecord.fields["email"] ?? "")
    .trim()
    .toLowerCase();
  if (!targetEmailNormalized) {
    return fail("TARGET_NO_EMAIL", "The matched member has no email address");
  }

  // ── Determine the target's city ──
  const cityCode = linkIdsFromField(targetRecord.fields[MEMBER_FIELDS.cityRelation])[0] ?? null;
  if (!cityCode) {
    return fail("TARGET_NO_CITY", "The member has no linked city (City relation)");
  }
  const cityName = (await resolveCityName(airtable, cityCode)) ?? cityCode;

  const effective = await resolveEffectiveCitySettings(db, cityCode);

  // ── Re-sync the target's semantic profile (paused members have none) ──
  await syncMemberSemanticProfile(targetRecord, { pinecone, db, log });

  // ── Load shared context ──
  const catalog = await loadMatchingOptionsCatalog(airtable);
  const pairHistory = await loadPairHistory(db, {
    pairDays: effective.constraints.repeatPairDays,
    memberDays: effective.constraints.memberCooldownDays,
  });

  // ── Fetch city members ──
  const records = await fetchCityMemberRecords(airtable, cityCode, cityName, log);
  log(`Fetched ${records.length} member record(s) for ${cityName}`);

  // ── Geo + vectors for the target and all city members ──
  const allRecords = records.some((r) => r.id === targetRecord.id)
    ? records
    : [targetRecord, ...records];

  const geos = await mapWithConcurrency(allRecords, 5, (record) =>
    resolveMemberGeo(db, {
      airtableRecordId: record.id,
      email: String(record.fields["email"] ?? ""),
      postcode: String(record.fields["post code"] ?? ""),
      city: String(record.fields["City"] ?? ""),
    })
  );
  const geoByRecordId = new Map<string, ResolvedGeo>();
  allRecords.forEach((record, i) => geoByRecordId.set(record.id, geos[i]));

  const vectorIds: string[] = [];
  for (const record of allRecords) {
    const ids = vectorIdsFor(record.id);
    vectorIds.push(ids.profile, ids.help, ids.expertise, ids.goal);
  }
  const vectors: Map<string, VectorRecord> = await pinecone.fetchByIds(vectorIds, namespace());

  // ── Build PlanMembers ──
  const build = (record: AirtableRecord): PlanMember =>
    buildPlanMember(record, {
      catalog,
      vectors,
      geo: geoByRecordId.get(record.id) ?? {
        lat: null,
        lon: null,
        displayName: null,
        source: "none",
        unknown: true,
      },
      runCityName: cityName,
    });

  const target = build(targetRecord);

  const eligiblePartners: PlanMember[] = [];
  for (const record of records) {
    if (record.id === targetRecord.id) continue;
    const member = build(record);
    const f = record.fields;
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
      { cycleDate: cycleDateObj, accessReference: now, runCity: cityName, constraints: effective.constraints }
    );
    if (result.eligible) eligiblePartners.push(member);
  }
  log(`Target ${target.email} + ${eligiblePartners.length} eligible partner(s)`);

  if (eligiblePartners.length < 2) {
    return fail(
      "INSUFFICIENT_PARTNERS",
      `City ${cityName} has only ${eligiblePartners.length} eligible member(s); 2 are required`
    );
  }

  // ── Pair matrix over target + partners (same scoring + hard constraints) ──
  const members = [target, ...eligiblePartners];
  const matrixResult = computePairMatrix(members, {
    cycleDate: cycleDateObj,
    constraints: effective.constraints,
    weights: effective.weights,
    pairHistory,
    maxDistanceKm: effective.constraints.maxDistanceKm,
  });
  const matrix = matrixResult.matrix;

  // ── Pick the best 2 partners maximizing the group score ──
  const best = selectBestPartners(target, eligiblePartners, matrix);

  if (!best) {
    return fail(
      "NO_ALLOWED_PARTNERS",
      `No two eligible partners in ${cityName} can be paired without violating the repeat/cooldown rules`
    );
  }

  const proposal: IndividualMatchProposal = {
    success: true,
    target: toPartnerInfo(target),
    partners: best.partners.map(toPartnerInfo),
    groupScore: Math.round(best.groupScore * 10000) / 10000,
    groupScoreBreakdown: combineBreakdowns(best.breakdowns),
    cityCode,
    cityName,
    eligiblePoolSize: eligiblePartners.length,
  };

  return {
    proposal,
    target,
    partners: best.partners,
    effective,
    targetRecord,
    cycleDate,
  };
}

/** Propose an individual match without writing anything. */
export async function previewIndividualMatch(
  deps: IndividualMatchDeps,
  targetEmail: string
): Promise<IndividualMatchProposal> {
  const resolved = await resolveProposal(deps, targetEmail);
  return resolved.proposal;
}

export interface IndividualMatchCreateInput {
  targetEmail: string;
  operator: string;
  deliveryMode?: DeliveryMode;
}

export interface IndividualMatchCreateResult {
  proposal: IndividualMatchProposal;
  runId: string | null;
  deliveryCount: number;
  frozen: boolean;
}

/** Propose, persist and freeze an individual introduction (delivery worker sends it). */
export async function createIndividualMatch(
  deps: IndividualMatchDeps,
  input: IndividualMatchCreateInput
): Promise<IndividualMatchCreateResult> {
  const { db, log } = deps;
  const deliveryMode: DeliveryMode = input.deliveryMode ?? "simulation";

  const resolved = await resolveProposal(deps, input.targetEmail);
  if (!resolved.proposal.success || !resolved.target || !resolved.effective) {
    return { proposal: resolved.proposal, runId: null, deliveryCount: 0, frozen: false };
  }

  const { target, partners, effective, cycleDate } = resolved;
  const { cityCode, cityName } = resolved.proposal;

  // ── Resolve the individual email template (ensure it exists) ──
  await ensureIndividualTemplate(db, { createdBy: input.operator });
  const individualTemplate = await resolveIndividualTemplate(db);

  const group = [target, ...partners];
  const runId = crypto.randomUUID();
  const cycleId = `individual-${runId}`;

  const snapshot = {
    seed: cycleId,
    cycleId,
    cycleDate,
    profileVersionId: effective.profileVersionId,
    templateVersionId: individualTemplate.versionId,
    members: group.map(toRegistryEntry),
  };

  await db.insert(introductionRuns).values({
    id: runId,
    requestId: runId,
    source: "individual",
    cycleDate,
    mode: "preview",
    dryRun: true,
    status: "planned",
    dueOnly: false,
    initiatedBy: input.operator,
    matchingProfileVersionId: effective.profileVersionId,
    emailTemplateVersionId: individualTemplate.versionId,
    cityCodesJson: JSON.stringify([cityCode]),
    deliveryMode,
    snapshotJson: JSON.stringify(snapshot),
    createdByClerkUserId: input.operator,
    totalGroups: 1,
    summary: `individual: ${target.name ?? target.email} + 2 in ${cityName ?? cityCode}`,
  });

  const groupId = crypto.randomUUID();
  const fingerprint = group
    .map((m) => m.key)
    .sort()
    .join("|");
  await db.insert(introductionGroups).values({
    id: groupId,
    runId,
    source: "individual",
    cycleId,
    cityRecordId: cityCode,
    cityName,
    groupFingerprint: fingerprint,
    status: "planned",
    overallScore: resolved.proposal.groupScore,
    scoreBreakdownJson: JSON.stringify(resolved.proposal.groupScoreBreakdown ?? {}),
    matchingProfileVersionId: effective.profileVersionId,
    cityCode,
    locked: false,
    reintroduced: false,
  });

  for (const member of group) {
    await db.insert(introductionGroupMembers).values({
      id: crypto.randomUUID(),
      groupId,
      airtableRecordId: member.airtableRecordId,
      emailSnapshot: member.email,
      role: "recurring",
      memberSnapshotJson: JSON.stringify(toRegistryEntry(member)),
    });
  }

  // Persist the three pair scores for review/edit consistency.
  const pairs: Array<[PlanMember, PlanMember]> = [
    [target, partners[0]],
    [target, partners[1]],
    [partners[0], partners[1]],
  ];
  const matrix = computePairMatrix(group, {
    cycleDate: new Date(`${cycleDate}T00:00:00Z`),
    constraints: effective.constraints,
    weights: effective.weights,
    pairHistory: { recentPairs: new Set<string>(), recentMemberEmails: new Set<string>() },
    maxDistanceKm: effective.constraints.maxDistanceKm,
  }).matrix;
  for (const [a, b] of pairs) {
    const entry = matrix.get(a.key, b.key);
    const score = entry?.score ?? { overall: 0, components: {} };
    await db.insert(introductionPairScores).values({
      id: crypto.randomUUID(),
      runId,
      memberAKey: a.key,
      memberBKey: b.key,
      pairKey: `${a.key}|${b.key}`,
      scoresJson: JSON.stringify(score),
      overall: score.overall,
    });
  }

  const frozen = await freezeIntroductionRun(db, {
    runId,
    deliveryMode,
    approvedBy: input.operator,
  });

  log(`Individual introduction ${runId} frozen (${frozen.deliveryCount} deliveries)`);

  return {
    proposal: resolved.proposal,
    runId,
    deliveryCount: frozen.deliveryCount,
    frozen: frozen.success,
  };
}
