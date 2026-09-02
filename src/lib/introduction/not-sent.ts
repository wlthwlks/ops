import { and, desc, inArray } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  introductionRuns,
  introductionGroups,
  introductionGroupMembers,
  introductionDeliveries,
  introductionDeliveryEvents,
} from "@/db/schema";
import { loadMatchingOptionsCatalog } from "@/lib/forms/reference-data/matching-options-catalog";
import {
  buildOptionLabelResolver,
  loadCityNameByCode,
  mapHistoryDeliveries,
  mapHistoryMembers,
  type HistoryDelivery,
  type HistoryDeliveryEvent,
  type HistoryMember,
} from "./history-lookup";

/**
 * "Not sent" view for the match-history page: everything that should have
 * produced an introduction email but did not — blocked/failed runs (no
 * groups at all), failed groups, and per-recipient deliveries that ended in
 * a terminal failure status.
 */

export const FAILED_DELIVERY_STATUSES = [
  "failed",
  "bounced",
  "suppressed",
  "complained",
] as const;

export const NOT_SENT_RUN_STATUSES = ["blocked", "failed"] as const;

const RUNS_WINDOW = 300;

export interface NotSentBlockedRun {
  id: string;
  cycleDate: string | null;
  source: string;
  status: string;
  deliveryMode: string;
  cityNames: string[];
  summary: string | null;
  error: string | null;
  createdAt: string;
}

export interface NotSentGroup {
  id: string;
  runId: string;
  cycleDate: string | null;
  source: string;
  deliveryMode: string;
  cityName: string | null;
  status: string;
  subject: string | null;
  sentAt: string | null;
  members: HistoryMember[];
  failedDeliveries: HistoryDelivery[];
}

export interface NotSentResponse {
  blockedRuns: NotSentBlockedRun[];
  groups: NotSentGroup[];
}

function cityNamesForRun(
  cityCodesJson: string | null,
  cityNameByCode: Map<string, string>
): string[] {
  let codes: string[] = [];
  try {
    const parsed = JSON.parse(cityCodesJson ?? "[]") as unknown;
    if (Array.isArray(parsed)) codes = parsed.map(String);
  } catch {
    codes = [];
  }
  return codes.map((code) => cityNameByCode.get(code) ?? code);
}

export async function listNotSentItems(db: AppDb): Promise<NotSentResponse> {
  const cityNameByCode = await loadCityNameByCode(db);

  const runs = await db
    .select()
    .from(introductionRuns)
    .orderBy(desc(introductionRuns.createdAt))
    .limit(RUNS_WINDOW);
  const runById = new Map(runs.map((run) => [run.id, run]));
  const runIds = runs.map((r) => r.id);

  const groups =
    runIds.length > 0
      ? await db
          .select()
          .from(introductionGroups)
          .where(inArray(introductionGroups.runId, runIds))
      : [];
  const groupById = new Map(groups.map((g) => [g.id, g]));

  const failedDeliveries =
    runIds.length > 0
      ? await db
          .select()
          .from(introductionDeliveries)
          .where(
            and(
              inArray(introductionDeliveries.runId, runIds),
              inArray(introductionDeliveries.status, [...FAILED_DELIVERY_STATUSES])
            )
          )
      : [];

  const failedGroupIds = new Set<string>();
  for (const group of groups) {
    if (group.status === "failed") failedGroupIds.add(group.id);
  }
  for (const delivery of failedDeliveries) {
    failedGroupIds.add(delivery.groupId);
  }
  const failedGroups = groups.filter((g) => failedGroupIds.has(g.id));

  const members =
    failedGroups.length > 0
      ? await db
          .select()
          .from(introductionGroupMembers)
          .where(
            inArray(
              introductionGroupMembers.groupId,
              failedGroups.map((g) => g.id)
            )
          )
      : [];
  const memberByGroup = new Map<string, typeof members>();
  for (const member of members) {
    const list = memberByGroup.get(member.groupId) ?? [];
    list.push(member);
    memberByGroup.set(member.groupId, list);
  }

  const deliveryIds = failedDeliveries.map((d) => d.id);
  const deliveryEvents =
    deliveryIds.length > 0
      ? await db
          .select()
          .from(introductionDeliveryEvents)
          .where(inArray(introductionDeliveryEvents.deliveryId, deliveryIds))
          .orderBy(introductionDeliveryEvents.providerTs)
      : [];
  const eventsByDelivery = new Map<string, HistoryDeliveryEvent[]>();
  for (const event of deliveryEvents) {
    const list = eventsByDelivery.get(event.deliveryId) ?? [];
    list.push({
      eventType: event.eventType,
      providerTs: event.providerTs ? event.providerTs.toISOString() : null,
    });
    eventsByDelivery.set(event.deliveryId, list);
  }
  const failedDeliveriesByGroup = mapHistoryDeliveries(
    failedDeliveries,
    eventsByDelivery
  );

  const catalog = await loadMatchingOptionsCatalog();
  const optionLabels = buildOptionLabelResolver(catalog);

  const groupItems: NotSentGroup[] = failedGroups
    .map((group) => {
      const run = runById.get(group.runId);
      return {
        id: group.id,
        runId: group.runId,
        cycleDate: run?.cycleDate ?? null,
        source: group.source,
        deliveryMode: run?.deliveryMode ?? "production",
        cityName: group.cityName ?? cityNameByCode.get(group.cityCode ?? "") ?? null,
        status: group.status,
        subject: group.emailSubjectSnapshot,
        sentAt: group.sentAt ? group.sentAt.toISOString() : null,
        members: mapHistoryMembers(memberByGroup.get(group.id) ?? [], optionLabels),
        failedDeliveries: failedDeliveriesByGroup.get(group.id) ?? [],
      } satisfies NotSentGroup;
    })
    .sort((a, b) => {
      const timeA = groupById.get(a.id)?.createdAt.getTime() ?? 0;
      const timeB = groupById.get(b.id)?.createdAt.getTime() ?? 0;
      return timeB - timeA;
    });

  // Blocked/failed runs that produced no groups at all — nothing was ever
  // sent for these cities. Runs superseded by a NEWER run for the same city
  // (e.g. a later successful re-run after the block was resolved) are stale
  // and hidden.
  const firstCityCode = (cityCodesJson: string | null): string | null => {
    try {
      const parsed = JSON.parse(cityCodesJson ?? "[]") as unknown;
      if (Array.isArray(parsed) && parsed.length > 0) return String(parsed[0]);
    } catch {
      // fall through
    }
    return null;
  };
  const blockedRuns: NotSentBlockedRun[] = runs
    .filter(
      (run) =>
        (NOT_SENT_RUN_STATUSES as readonly string[]).includes(run.status) &&
        !groups.some((g) => g.runId === run.id)
    )
    .filter((run) => {
      const code = firstCityCode(run.cityCodesJson);
      if (!code) return true;
      return !runs.some(
        (other) =>
          other.id !== run.id &&
          other.createdAt.getTime() > run.createdAt.getTime() &&
          firstCityCode(other.cityCodesJson) === code
      );
    })
    .map((run) => ({
      id: run.id,
      cycleDate: run.cycleDate,
      source: run.source,
      status: run.status,
      deliveryMode: run.deliveryMode,
      cityNames: cityNamesForRun(run.cityCodesJson, cityNameByCode),
      summary: run.summary,
      error: run.error,
      createdAt: run.createdAt.toISOString(),
    }));

  return { blockedRuns, groups: groupItems };
}
