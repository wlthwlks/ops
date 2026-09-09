import { and, desc, gte, ilike, inArray, eq, type SQLWrapper } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  introductionDeliveries,
  introductionDeliveryEvents,
  introductionGroups,
  introductionRuns,
} from "@/db/schema";
import {
  loadCityNameByCode,
  parseOriginalTo,
  type HistoryDeliveryEvent,
} from "./history-lookup";

/**
 * Provider-reported delivery states for the "Delivery States" tab: every
 * delivery that reached the email provider and produced a terminal or
 * in-flight state (delivered, delayed, bounced, suppressed, complained,
 * failed). Queue-internal states (pending/sent) are excluded.
 */

export const PROVIDER_DELIVERY_STATUSES = [
  "delivered",
  "delayed",
  "bounced",
  "suppressed",
  "complained",
  "failed",
] as const;

export const DEFAULT_DELIVERY_STATES_WINDOW_DAYS = 14;
export const DELIVERY_STATES_LIMIT = 500;

export interface DeliveryStateRow {
  id: string;
  groupId: string;
  runId: string;
  cycleDate: string | null;
  source: string;
  deliveryMode: string;
  cityName: string | null;
  recipientEmail: string;
  recipientName: string | null;
  deliverToEmail: string;
  originalTo: string[] | null;
  status: string;
  resendMessageId: string | null;
  attemptCount: number;
  error: string | null;
  sentAt: string | null;
  lastEventAt: string | null;
  events: HistoryDeliveryEvent[];
}

export interface DeliveryStatesOptions {
  /** Rolling window in days; 0/null means no cutoff. */
  days?: number;
  statuses?: string[];
  cityCode?: string;
  person?: string;
}

export async function listDeliveryStates(
  db: AppDb,
  options: DeliveryStatesOptions = {}
): Promise<DeliveryStateRow[]> {
  const days = options.days ?? DEFAULT_DELIVERY_STATES_WINDOW_DAYS;
  const statuses =
    options.statuses && options.statuses.length > 0
      ? options.statuses
      : [...PROVIDER_DELIVERY_STATUSES];
  const cityCode = (options.cityCode ?? "").trim();
  const person = (options.person ?? "").trim();

  const where: SQLWrapper[] = [inArray(introductionDeliveries.status, statuses)];
  if (days > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    where.push(gte(introductionDeliveries.createdAt, cutoff));
  }
  if (cityCode) {
    where.push(eq(introductionGroups.cityCode, cityCode));
  }
  if (person) {
    where.push(
      ilike(introductionDeliveries.recipientEmail, `%${person}%`)
    );
  }

  const rows = await db
    .select({
      id: introductionDeliveries.id,
      groupId: introductionDeliveries.groupId,
      runId: introductionDeliveries.runId,
      cycleDate: introductionRuns.cycleDate,
      source: introductionGroups.source,
      deliveryMode: introductionRuns.deliveryMode,
      cityName: introductionGroups.cityName,
      cityCode: introductionGroups.cityCode,
      recipientEmail: introductionDeliveries.recipientEmail,
      recipientName: introductionDeliveries.recipientName,
      deliverToEmail: introductionDeliveries.deliverToEmail,
      originalToJson: introductionDeliveries.originalToJson,
      status: introductionDeliveries.status,
      resendMessageId: introductionDeliveries.resendMessageId,
      attemptCount: introductionDeliveries.attemptCount,
      error: introductionDeliveries.error,
      sentAt: introductionDeliveries.sentAt,
      lastEventAt: introductionDeliveries.lastEventAt,
    })
    .from(introductionDeliveries)
    .innerJoin(
      introductionGroups,
      eq(introductionGroups.id, introductionDeliveries.groupId)
    )
    .innerJoin(
      introductionRuns,
      eq(introductionRuns.id, introductionDeliveries.runId)
    )
    .where(and(...where))
    .orderBy(desc(introductionDeliveries.createdAt))
    .limit(DELIVERY_STATES_LIMIT);

  const deliveryIds = rows.map((r) => r.id);
  const eventRows =
    deliveryIds.length > 0
      ? await db
          .select()
          .from(introductionDeliveryEvents)
          .where(inArray(introductionDeliveryEvents.deliveryId, deliveryIds))
          .orderBy(introductionDeliveryEvents.providerTs)
      : [];
  const eventsByDelivery = new Map<string, HistoryDeliveryEvent[]>();
  for (const event of eventRows) {
    const list = eventsByDelivery.get(event.deliveryId) ?? [];
    list.push({
      eventType: event.eventType,
      providerTs: event.providerTs ? event.providerTs.toISOString() : null,
    });
    eventsByDelivery.set(event.deliveryId, list);
  }

  const cityNameByCode = await loadCityNameByCode(db);

  return rows.map((row) => ({
    id: row.id,
    groupId: row.groupId,
    runId: row.runId,
    cycleDate: row.cycleDate,
    source: row.source,
    deliveryMode: row.deliveryMode,
    cityName: row.cityName ?? cityNameByCode.get(row.cityCode ?? "") ?? null,
    recipientEmail: row.recipientEmail,
    recipientName: row.recipientName,
    deliverToEmail: row.deliverToEmail,
    originalTo: parseOriginalTo(row.originalToJson),
    status: row.status,
    resendMessageId: row.resendMessageId,
    attemptCount: row.attemptCount,
    error: row.error,
    sentAt: row.sentAt ? row.sentAt.toISOString() : null,
    lastEventAt: row.lastEventAt ? row.lastEventAt.toISOString() : null,
    events: eventsByDelivery.get(row.id) ?? [],
  }));
}
