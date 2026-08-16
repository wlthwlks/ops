import { eq, inArray } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  introductionDeliveries,
  introductionDeliveryEvents,
  introductionGroups,
  introductionGroupMembers,
  introductionRuns,
} from "@/db/schema";
import { isValidEmail } from "./member-eligibility";
import { DEFAULT_BATCH_SIZE } from "./delivery-queue";

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
  duplicateMembers: string[];
  repeatedPairsBlocked: number | null;
  invalidEmails: string[];
  renderedEmails: number;
  recipientCount: number;
  canaryRedirectCount: number;
  queue: QueueSizeEstimate;
  validationFailures: string[];
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
  if (run.snapshotJson) {
    try {
      const snapshot = JSON.parse(run.snapshotJson) as {
        members?: Array<{ key: string; email: string }>;
      };
      snapshotMembers = snapshot.members ?? [];
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
  const unmatchedMembers = snapshotMembers.filter((m) => !matchedKeys.has(m.email.trim().toLowerCase())).length;

  const validationFailures: string[] = [];
  if (invalidEmails.length > 0) {
    validationFailures.push(`${invalidEmails.length} recipient(s) with invalid deliver-to email`);
  }
  if (duplicates.length > 0) {
    validationFailures.push(`${duplicates.length} member(s) appear in more than one group`);
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
    unmatchedMembers,
    duplicateMembers: duplicates,
    repeatedPairsBlocked: null,
    invalidEmails,
    renderedEmails,
    recipientCount: deliveries.length,
    canaryRedirectCount,
    queue: estimateQueueSizes(groups.length, deliveries.length),
    validationFailures,
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
