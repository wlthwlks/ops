import { and, eq, ilike, inArray, type SQLWrapper } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  introductionDeliveries,
  introductionDeliveryEvents,
  introductionGroups,
  introductionRuns,
} from "@/db/schema";
import type { ResendEmailSummary } from "@/lib/integrations/resend-emails";
import {
  loadCityNameByCode,
  parseOriginalTo,
  type HistoryDeliveryEvent,
} from "./history-lookup";

/**
 * Live "Delivery States" view: merges the Resend emails list (paginated via
 * the Resend API, carrying the latest delivery event per email) with our
 * introduction delivery ledger, matched on the stored resend message id.
 * The Resend `last_event` is the displayed status — it reflects reality even
 * while the Resend webhook pipeline is not receiving events.
 */

export const LIVE_DELIVERY_STATES_LIMIT = 500;

/** Resend last_event values → our delivery status vocabulary. */
const LAST_EVENT_NORMALIZATION: Record<string, string> = {
  delivery_delayed: "delayed",
};

export function normalizeResendLastEvent(lastEvent: string | null): string {
  const raw = (lastEvent ?? "").trim().toLowerCase();
  if (!raw) return "sent";
  return LAST_EVENT_NORMALIZATION[raw] ?? raw;
}

export interface LiveDeliveryStateRow {
  /** introduction_deliveries.id */
  id: string;
  groupId: string;
  cycleDate: string | null;
  source: string;
  deliveryMode: string;
  cityName: string | null;
  recipientEmail: string;
  recipientName: string | null;
  deliverToEmail: string;
  originalTo: string[] | null;
  /** Live Resend last_event (normalized). */
  status: string;
  /** Stored introduction_deliveries.status (may lag until webhooks work). */
  storedStatus: string;
  error: string | null;
  /** Resend email created_at — the real send time. */
  sentAt: string | null;
  resendMessageId: string;
  subject: string | null;
  from: string | null;
  /** Stored DB last provider event timestamp. */
  lastEventAt: string | null;
  events: HistoryDeliveryEvent[];
}

export interface LiveDeliveryStatesOptions {
  /** Filter on the live Resend status; empty = all. */
  statuses?: string[];
  cityCode?: string;
  person?: string;
}

export async function listLiveDeliveryStates(
  db: AppDb,
  emails: ResendEmailSummary[],
  options: LiveDeliveryStatesOptions = {}
): Promise<LiveDeliveryStateRow[]> {
  const emailById = new Map<string, ResendEmailSummary>();
  for (const email of emails) {
    if (email.id) emailById.set(email.id, email);
  }
  const messageIds = [...emailById.keys()];
  if (messageIds.length === 0) return [];

  const statuses = options.statuses ?? [];
  const cityCode = (options.cityCode ?? "").trim();
  const person = (options.person ?? "").trim();

  const where: SQLWrapper[] = [
    inArray(introductionDeliveries.resendMessageId, messageIds),
  ];
  if (cityCode) where.push(eq(introductionGroups.cityCode, cityCode));
  if (person) where.push(ilike(introductionDeliveries.recipientEmail, `%${person}%`));

  const rows = await db
    .select({
      id: introductionDeliveries.id,
      groupId: introductionDeliveries.groupId,
      cycleDate: introductionRuns.cycleDate,
      source: introductionGroups.source,
      deliveryMode: introductionRuns.deliveryMode,
      cityName: introductionGroups.cityName,
      cityCode: introductionGroups.cityCode,
      recipientEmail: introductionDeliveries.recipientEmail,
      recipientName: introductionDeliveries.recipientName,
      deliverToEmail: introductionDeliveries.deliverToEmail,
      originalToJson: introductionDeliveries.originalToJson,
      storedStatus: introductionDeliveries.status,
      error: introductionDeliveries.error,
      resendMessageId: introductionDeliveries.resendMessageId,
      lastEventAt: introductionDeliveries.lastEventAt,
    })
    .from(introductionDeliveries)
    .innerJoin(introductionGroups, eq(introductionGroups.id, introductionDeliveries.groupId))
    .innerJoin(introductionRuns, eq(introductionRuns.id, introductionDeliveries.runId))
    .where(and(...where));

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

  const merged: LiveDeliveryStateRow[] = [];
  for (const row of rows) {
    if (!row.resendMessageId) continue;
    const email = emailById.get(row.resendMessageId);
    if (!email) continue;
    const status = normalizeResendLastEvent(email.lastEvent);
    if (statuses.length > 0 && !statuses.includes(status)) continue;
    merged.push({
      id: row.id,
      groupId: row.groupId,
      cycleDate: row.cycleDate,
      source: row.source,
      deliveryMode: row.deliveryMode,
      cityName: row.cityName ?? cityNameByCode.get(row.cityCode ?? "") ?? null,
      recipientEmail: row.recipientEmail,
      recipientName: row.recipientName,
      deliverToEmail: row.deliverToEmail,
      originalTo: parseOriginalTo(row.originalToJson),
      status,
      storedStatus: row.storedStatus,
      error: row.error,
      sentAt: email.createdAt,
      resendMessageId: row.resendMessageId,
      subject: email.subject,
      from: email.from,
      lastEventAt: row.lastEventAt ? row.lastEventAt.toISOString() : null,
      events: eventsByDelivery.get(row.id) ?? [],
    });
  }

  merged.sort((a, b) => {
    const aTime = a.sentAt ? Date.parse(a.sentAt) : 0;
    const bTime = b.sentAt ? Date.parse(b.sentAt) : 0;
    if (Number.isNaN(aTime)) return 1;
    if (Number.isNaN(bTime)) return -1;
    return bTime - aTime;
  });

  return merged.slice(0, LIVE_DELIVERY_STATES_LIMIT);
}
