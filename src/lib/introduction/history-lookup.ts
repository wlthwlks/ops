import { and, desc, eq, ilike, inArray, isNull, or, type SQLWrapper } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  introductionRuns,
  introductionGroups,
  introductionGroupMembers,
  introductionDeliveries,
  introductionDeliveryEvents,
  introductionPairScores,
  matchEvents,
  matchEventMatches,
  cityIntroductionSettings,
} from "@/db/schema";
import {
  loadMatchingOptionsCatalog,
  type MatchingOptionsCatalog,
} from "@/lib/forms/reference-data/matching-options-catalog";
import { prettifyCode } from "./render-email";
import type { PlanMemberRegistryEntry } from "./plan";

/**
 * Customer-service match history lookup: search the unified introduction
 * ledger plus the legacy "Get Matched" events by person (email / name /
 * Airtable record id) and/or city.
 */

const RUNS_WINDOW = 300;
const RESULTS_LIMIT = 50;

export interface HistoryMember {
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

export interface HistoryDeliveryEvent {
  eventType: string;
  providerTs: string | null;
}

export interface HistoryDelivery {
  id: string;
  recipientEmail: string;
  recipientName: string | null;
  deliverToEmail: string;
  originalTo: string[] | null;
  status: string;
  resendMessageId: string | null;
  attemptCount: number;
  error: string | null;
  sentAt: string | null;
  events: HistoryDeliveryEvent[];
}

export interface HistoryPairScore {
  memberAKey: string;
  memberBKey: string;
  overall: number;
  scores: Record<string, number>;
}

export interface HistoryGroup {
  id: string;
  cityName: string | null;
  status: string;
  overallScore: number | null;
  scoreBreakdown: Record<string, number> | null;
  sentAt: string | null;
  subject: string | null;
  members: HistoryMember[];
  deliveries: HistoryDelivery[];
}

export interface HistoryRunResult {
  source: "unified";
  run: {
    id: string;
    cycleDate: string | null;
    status: string;
    deliveryMode: string;
    createdAt: string;
    cityCodes: string[];
  };
  groups: HistoryGroup[];
  pairScores: HistoryPairScore[];
}

export interface LegacyMatchRow {
  rank: number;
  email: string;
  postcode: string | null;
  city: string | null;
  industry: string | null;
  similarityScore: number | null;
}

export interface LegacyHistoryResult {
  source: "legacy";
  event: {
    id: string;
    createdAt: string;
    mode: string;
    newMemberEmail: string;
    newMemberPostcode: string | null;
    newMemberCity: string | null;
    newMemberIndustry: string | null;
    summary: string | null;
    error: string | null;
    slackSentAt: string | null;
    slackRecipientCount: number | null;
  };
  matches: LegacyMatchRow[];
}

export type HistorySearchResultItem = HistoryRunResult | LegacyHistoryResult;

export interface HistorySearchParams {
  person?: string;
  city?: string;
}

export interface HistorySearchResponse {
  query: { person: string | null; city: string | null };
  results: HistorySearchResultItem[];
}

function parseSnapshot(raw: string | null): PlanMemberRegistryEntry | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PlanMemberRegistryEntry;
  } catch {
    return null;
  }
}

function parseScoresJson(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, number>;
    }
  } catch {
    // fall through
  }
  return {};
}

export type HistoryOptionLabelResolver = (
  codes: string[] | undefined | null
) => string[];

export function buildOptionLabelResolver(
  catalog: MatchingOptionsCatalog
): HistoryOptionLabelResolver {
  const labelByCode = new Map<string, string>();
  for (const option of [...catalog.helpWantedOptions, ...catalog.expertiseOptions]) {
    if (option.code && option.label) labelByCode.set(option.code, option.label);
  }
  return (codes) =>
    (codes ?? []).map((code) => labelByCode.get(code) ?? prettifyCode(code));
}

export function mapHistoryMembers(
  members: (typeof introductionGroupMembers.$inferSelect)[],
  optionLabels: HistoryOptionLabelResolver
): HistoryMember[] {
  return members.map((member) => {
    const snapshot = parseSnapshot(member.memberSnapshotJson);
    return {
      key: snapshot?.key ?? member.emailSnapshot,
      email: snapshot?.email ?? member.emailSnapshot,
      airtableRecordId: snapshot?.airtableRecordId ?? member.airtableRecordId ?? "",
      name: snapshot?.name ?? null,
      firstName: snapshot?.firstName ?? null,
      city: snapshot?.city ?? null,
      postcode: snapshot?.postcode ?? null,
      industry: snapshot?.industry ?? null,
      businessStage: snapshot?.businessStage ?? null,
      professionalHeadline: snapshot?.professionalHeadline ?? null,
      phone: snapshot?.phone ?? null,
      socialMedia: snapshot?.socialMedia ?? null,
      website: snapshot?.website ?? null,
      helpWanted: optionLabels(snapshot?.helpWanted),
      expertise: optionLabels(snapshot?.expertise),
      connectionTypes: snapshot?.connectionTypes ?? [],
    } satisfies HistoryMember;
  });
}

export function parseOriginalTo(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through
  }
  return null;
}

export function mapHistoryDeliveries(
  deliveries: (typeof introductionDeliveries.$inferSelect)[],
  eventsByDelivery: Map<string, HistoryDeliveryEvent[]>
): Map<string, HistoryDelivery[]> {
  const byGroup = new Map<string, HistoryDelivery[]>();
  for (const delivery of deliveries) {
    const list = byGroup.get(delivery.groupId) ?? [];
    list.push({
      id: delivery.id,
      recipientEmail: delivery.recipientEmail,
      recipientName: delivery.recipientName,
      deliverToEmail: delivery.deliverToEmail,
      originalTo: parseOriginalTo(delivery.originalToJson),
      status: delivery.status,
      resendMessageId: delivery.resendMessageId,
      attemptCount: delivery.attemptCount,
      error: delivery.error,
      sentAt: delivery.sentAt ? delivery.sentAt.toISOString() : null,
      events: eventsByDelivery.get(delivery.id) ?? [],
    });
    byGroup.set(delivery.groupId, list);
  }
  return byGroup;
}

export async function loadCityNameByCode(db: AppDb): Promise<Map<string, string>> {
  const cityNameByCode = new Map<string, string>();
  const cityRows = await db
    .select({ code: cityIntroductionSettings.cityCode, name: cityIntroductionSettings.cityName })
    .from(cityIntroductionSettings);
  for (const row of cityRows) {
    if (row.name) cityNameByCode.set(row.code, row.name);
  }
  return cityNameByCode;
}

export async function searchIntroductionHistory(
  db: AppDb,
  params: HistorySearchParams
): Promise<HistorySearchResponse> {
  const person = (params.person ?? "").trim().toLowerCase();
  const city = (params.city ?? "").trim().toLowerCase();

  const catalog = await loadMatchingOptionsCatalog();
  const optionLabels = buildOptionLabelResolver(catalog);

  // ─── Unified ledger ─────────────────────────────────────────────────
  const runs = await db
    .select()
    .from(introductionRuns)
    .orderBy(desc(introductionRuns.createdAt))
    .limit(RUNS_WINDOW);
  const runIds = runs.map((r) => r.id);

  const groupWhere: SQLWrapper[] = [];
  if (runIds.length > 0) groupWhere.push(inArray(introductionGroups.runId, runIds));
  const groups = await db
    .select()
    .from(introductionGroups)
    .where(groupWhere.length > 0 ? and(...groupWhere) : undefined)
    .orderBy(desc(introductionGroups.createdAt));
  const groupIds = groups.map((g) => g.id);

  // Phase 1: if a person is given, find which groups contain a matching
  // member. Otherwise every group in the window is a candidate.
  let candidateGroupIds: string[] = groupIds;
  if (person && groupIds.length > 0) {
    const matchingMembers = await db
      .select({ groupId: introductionGroupMembers.groupId })
      .from(introductionGroupMembers)
      .where(
        and(
          inArray(introductionGroupMembers.groupId, groupIds),
          or(
            ilike(introductionGroupMembers.emailSnapshot, `%${person}%`),
            ilike(introductionGroupMembers.airtableRecordId, `%${person}%`),
            ilike(introductionGroupMembers.memberSnapshotJson, `%${person}%`)
          )
        )
      );
    candidateGroupIds = [...new Set(matchingMembers.map((m) => m.groupId))];
  }

  const cityCodesByRun = new Map<string, string[]>();
  for (const run of runs) {
    try {
      const parsed = JSON.parse(run.cityCodesJson ?? "[]") as unknown;
      cityCodesByRun.set(run.id, Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      cityCodesByRun.set(run.id, []);
    }
  }

  const candidateGroupSet = new Set(candidateGroupIds);
  const keptGroupIds = groups
    .filter((group) => {
      if (!candidateGroupSet.has(group.id)) return false;
      if (!city) return true;
      if (group.cityName?.toLowerCase().includes(city)) return true;
      const codes = cityCodesByRun.get(group.runId) ?? [];
      return codes.some((code) => code.toLowerCase() === city);
    })
    .map((g) => g.id);
  const keptGroupSet = new Set(keptGroupIds);

  const keptRunIds = [
    ...new Set(groups.filter((g) => keptGroupSet.has(g.id)).map((g) => g.runId)),
  ];

  // Phase 2: fetch every member of the kept groups (full group context).
  const members =
    keptGroupIds.length > 0
      ? await db
          .select()
          .from(introductionGroupMembers)
          .where(inArray(introductionGroupMembers.groupId, keptGroupIds))
      : [];
  const memberByGroup = new Map<string, typeof members>();
  for (const member of members) {
    const list = memberByGroup.get(member.groupId) ?? [];
    list.push(member);
    memberByGroup.set(member.groupId, list);
  }

  const deliveries =
    keptRunIds.length > 0
      ? await db
          .select()
          .from(introductionDeliveries)
          .where(inArray(introductionDeliveries.runId, keptRunIds))
          .orderBy(introductionDeliveries.createdAt)
      : [];
  const deliveryIds = deliveries.map((d) => d.id);
  const [deliveryEvents, pairScores] = await Promise.all([
    deliveryIds.length > 0
      ? db
          .select()
          .from(introductionDeliveryEvents)
          .where(inArray(introductionDeliveryEvents.deliveryId, deliveryIds))
          .orderBy(introductionDeliveryEvents.providerTs)
      : [],
    keptRunIds.length > 0
      ? db
          .select()
          .from(introductionPairScores)
          .where(inArray(introductionPairScores.runId, keptRunIds))
      : [],
  ]);

  const eventsByDelivery = new Map<string, HistoryDeliveryEvent[]>();
  for (const event of deliveryEvents) {
    const list = eventsByDelivery.get(event.deliveryId) ?? [];
    list.push({
      eventType: event.eventType,
      providerTs: event.providerTs ? event.providerTs.toISOString() : null,
    });
    eventsByDelivery.set(event.deliveryId, list);
  }
  const deliveriesByGroup = mapHistoryDeliveries(deliveries, eventsByDelivery);
  const pairScoresByRun = new Map<string, HistoryPairScore[]>();
  for (const score of pairScores) {
    const list = pairScoresByRun.get(score.runId) ?? [];
    list.push({
      memberAKey: score.memberAKey,
      memberBKey: score.memberBKey,
      overall: score.overall,
      scores: parseScoresJson(score.scoresJson),
    });
    pairScoresByRun.set(score.runId, list);
  }

  const results: HistorySearchResultItem[] = [];
  const runById = new Map(runs.map((run) => [run.id, run]));

  // City display names for groups whose cityName is null (transient cases).
  const cityNameByCode = await loadCityNameByCode(db);

  for (const runId of keptRunIds) {
    const run = runById.get(runId);
    if (!run) continue;
    const runGroups = groups
      .filter((g) => g.runId === runId && keptGroupSet.has(g.id))
      .map((group) => {
        const groupMembers = mapHistoryMembers(
          memberByGroup.get(group.id) ?? [],
          optionLabels
        );
        let scoreBreakdown: Record<string, number> | null = null;
        if (group.scoreBreakdownJson) {
          scoreBreakdown = parseScoresJson(group.scoreBreakdownJson);
        }
        return {
          id: group.id,
          cityName: group.cityName ?? cityNameByCode.get(group.cityCode ?? "") ?? null,
          status: group.status,
          overallScore: group.overallScore,
          scoreBreakdown,
          sentAt: group.sentAt ? group.sentAt.toISOString() : null,
          subject: group.emailSubjectSnapshot,
          members: groupMembers,
          deliveries: deliveriesByGroup.get(group.id) ?? [],
        } satisfies HistoryGroup;
      });
    results.push({
      source: "unified",
      run: {
        id: run.id,
        cycleDate: run.cycleDate,
        status: run.status,
        deliveryMode: run.deliveryMode,
        createdAt: run.createdAt.toISOString(),
        cityCodes: cityCodesByRun.get(run.id) ?? [],
      },
      groups: runGroups,
      pairScores: pairScoresByRun.get(run.id) ?? [],
    });
  }

  // ─── Legacy "Get Matched" events ────────────────────────────────────
  const legacyEvents = await db
    .select()
    .from(matchEvents)
    .where(and(eq(matchEvents.dryRun, false), isNull(matchEvents.deletedAt)))
    .orderBy(desc(matchEvents.createdAt))
    .limit(RESULTS_LIMIT);
  const legacyEventIds = legacyEvents.map((e) => e.id);
  const legacyMatches =
    legacyEventIds.length > 0
      ? await db
          .select()
          .from(matchEventMatches)
          .where(inArray(matchEventMatches.matchEventId, legacyEventIds))
          .orderBy(matchEventMatches.rank)
      : [];
  const legacyByEvent = new Map<string, typeof legacyMatches>();
  for (const match of legacyMatches) {
    const list = legacyByEvent.get(match.matchEventId) ?? [];
    list.push(match);
    legacyByEvent.set(match.matchEventId, list);
  }

  for (const event of legacyEvents) {
    const eventMatches = legacyByEvent.get(event.id) ?? [];
    const matchesPerson =
      !person ||
      event.newMemberEmail.toLowerCase().includes(person) ||
      eventMatches.some((m) => m.matchEmail.toLowerCase().includes(person));
    const matchesCity =
      !city ||
      (event.newMemberCity ?? "").toLowerCase().includes(city) ||
      eventMatches.some((m) => (m.matchCity ?? "").toLowerCase().includes(city));
    if (!matchesPerson || !matchesCity) continue;
    results.push({
      source: "legacy",
      event: {
        id: event.id,
        createdAt: event.createdAt.toISOString(),
        mode: event.mode,
        newMemberEmail: event.newMemberEmail,
        newMemberPostcode: event.newMemberPostcode,
        newMemberCity: event.newMemberCity,
        newMemberIndustry: event.newMemberIndustry,
        summary: event.summary,
        error: event.error,
        slackSentAt: event.slackSentAt ? event.slackSentAt.toISOString() : null,
        slackRecipientCount: event.slackRecipientCount,
      },
      matches: eventMatches.map((m) => ({
        rank: m.rank,
        email: m.matchEmail,
        postcode: m.matchPostcode,
        city: m.matchCity,
        industry: m.matchIndustry,
        similarityScore: m.similarityScore,
      })),
    });
  }

  return {
    query: { person: params.person ?? null, city: params.city ?? null },
    results: results.slice(0, RESULTS_LIMIT),
  };
}
