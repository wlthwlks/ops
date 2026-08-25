import { and, eq, inArray, sql } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  introductionDeliveries,
  introductionGroups,
  introductionRuns,
  type IntroductionDelivery,
  type IntroductionGroup,
  type IntroductionRun,
} from "@/db/schema";
import { getGlobalIntroductionConfig } from "./settings";
import type { ResendBatchMessage } from "@/lib/integrations/resend";

/**
 * Durable, database-backed delivery queue for frozen introduction plans.
 *
 * The claim is a single conditional UPDATE (the `AND status='approved'` guard
 * makes concurrent workers safe), deliveries carry unique delivery keys and
 * provider idempotency keys, only transient failures are retried (with
 * exponential backoff), and stale claims are reclaimed so a worker that dies
 * mid-batch can never strand a city.
 */

export const MAX_ATTEMPTS = 5;
export const STALE_CLAIM_MINUTES = 10;
export const DEFAULT_BATCH_SIZE = 20;

export interface GroupEmailMessage extends ResendBatchMessage {
  runId: string;
  groupId: string;
}

export interface GroupEmailBatchSender {
  sendBatch(messages: GroupEmailMessage[]): Promise<
    Array<{ ok: boolean; permanent: boolean; id?: string; error?: string }>
  >;
}

export interface DeliveryQueueDeps {
  db: AppDb;
  sender: GroupEmailBatchSender;
  log: (message: string) => void;
  now?: Date;
  /** True only when INTRODUCTIONS_MODE is live — never send otherwise. */
  live?: boolean;
}

export interface DeliveryTickResult {
  processed: boolean;
  skipped: boolean;
  reason: string | null;
  claimed: number;
  sent: number;
  failed: number;
  deferred: number;
  reclaimed: number;
  staleGroupsReset: number;
}

function retryBackoffMs(attemptCount: number): number {
  return Math.min(60 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, attemptCount - 1));
}

/** Reclaim deliveries/groups stuck in processing by dead workers. */
export async function resetStaleClaims(
  db: AppDb,
  opts: { staleMinutes?: number; now?: Date } = {}
): Promise<{ deliveries: number; groups: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.staleMinutes ?? STALE_CLAIM_MINUTES) * 60_000);

  const deliveries = await db.execute(
    sql`UPDATE introduction_deliveries
        SET status = 'pending', claimed_at = NULL
        WHERE status = 'processing' AND claimed_at IS NOT NULL AND claimed_at < ${cutoff}
        RETURNING id`
  );
  const groups = await db.execute(
    sql`UPDATE introduction_groups
        SET status = 'approved', claimed_at = NULL
        WHERE status = 'sending' AND claimed_at IS NOT NULL AND claimed_at < ${cutoff}
        RETURNING id`
  );
  return { deliveries: deliveries.rows.length, groups: groups.rows.length };
}

interface ClaimedGroup {
  group: IntroductionGroup;
  run: IntroductionRun;
  deliveries: IntroductionDelivery[];
}

/**
 * Claim one eligible group with a conditional UPDATE. Only approved runs
 * with a non-simulation delivery mode are ever claimed.
 */
async function claimGroup(db: AppDb, now: Date): Promise<{ groupId: string; runId: string } | null> {
  const claimed = await db.execute(
    sql`UPDATE introduction_groups g
        SET status = 'sending', claimed_at = ${now}, attempt_count = attempt_count + 1
        WHERE g.id IN (
          SELECT g2.id
          FROM introduction_groups g2
          JOIN introduction_runs r ON r.id = g2.run_id
          JOIN introduction_deliveries d ON d.group_id = g2.id
          WHERE g2.status = 'approved'
            AND r.status = 'approved'
            AND r.delivery_mode <> 'simulation'
            AND d.status = 'pending'
            AND (d.next_retry_at IS NULL OR d.next_retry_at <= ${now})
          ORDER BY g2.created_at
          LIMIT 1
        )
        AND g.status = 'approved'
        RETURNING g.id AS group_id, g.run_id AS run_id`
  );
  const row = claimed.rows[0] as { group_id: string; run_id: string } | undefined;
  return row ? { groupId: row.group_id, runId: row.run_id } : null;
}

async function loadClaimedGroup(db: AppDb, groupId: string, runId: string): Promise<ClaimedGroup | null> {
  const groupRows = await db
    .select()
    .from(introductionGroups)
    .where(eq(introductionGroups.id, groupId))
    .limit(1);
  const runRows = await db
    .select()
    .from(introductionRuns)
    .where(eq(introductionRuns.id, runId))
    .limit(1);
  if (!groupRows[0] || !runRows[0]) return null;
  const deliveries = await db
    .select()
    .from(introductionDeliveries)
    .where(
      and(
        eq(introductionDeliveries.groupId, groupId),
        inArray(introductionDeliveries.status, ["pending", "processing"])
      )
    );
  return { group: groupRows[0], run: runRows[0], deliveries };
}

async function syncRunStatus(db: AppDb, runId: string): Promise<void> {
  const open = await db.execute(
    sql`SELECT COUNT(*)::int AS count
        FROM introduction_groups g
        WHERE g.run_id = ${runId}
          AND g.status NOT IN ('sent', 'failed', 'skipped', 'blocked')`
  );
  const count = (open.rows[0] as { count: number } | undefined)?.count ?? 0;
  if (count === 0) {
    await db
      .update(introductionRuns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(introductionRuns.id, runId));
  }
}

export interface ProcessGroupOutcome {
  groupId: string;
  runId: string;
  outcome: "sent" | "failed" | "deferred" | "skipped";
}

interface DeliveryOutcomeEntry {
  deliveryId: string;
  result: { ok: boolean; permanent: boolean; id?: string; error?: string };
}

async function deferDelivery(
  db: AppDb,
  delivery: IntroductionDelivery,
  error: string,
  now: Date
): Promise<void> {
  const nextRetryAt = new Date(now.getTime() + retryBackoffMs(delivery.attemptCount));
  await db
    .update(introductionDeliveries)
    .set({
      status: "pending",
      nextRetryAt,
      error,
      claimedAt: null,
    })
    .where(eq(introductionDeliveries.id, delivery.id));
}

/**
 * Persist per-delivery provider results. A group is `sent` when all of its
 * deliveries sent, `failed` when any delivery failed permanently (or hit
 * the retry limit), and `deferred` while some deliveries still retry.
 */
async function applyDeliveryResults(
  db: AppDb,
  claimed: ClaimedGroup,
  entries: DeliveryOutcomeEntry[],
  now: Date,
  log: (message: string) => void
): Promise<ProcessGroupOutcome> {
  const { group, run, deliveries } = claimed;
  const byId = new Map(entries.map((e) => [e.deliveryId, e.result]));

  let sent = 0;
  let failed = 0;
  let deferred = 0;

  for (const delivery of deliveries) {
    const result = byId.get(delivery.id);
    if (!result) {
      // No provider result for this delivery — treat as transient.
      deferred += 1;
      await deferDelivery(db, delivery, "Missing provider result", now);
      continue;
    }

    if (result.ok && result.id) {
      await db
        .update(introductionDeliveries)
        .set({
          status: "sent",
          resendMessageId: result.id,
          sentAt: now,
          nextRetryAt: null,
          error: null,
          claimedAt: null,
        })
        .where(eq(introductionDeliveries.id, delivery.id));
      sent += 1;
      continue;
    }

    if (result.permanent) {
      await db
        .update(introductionDeliveries)
        .set({
          status: "failed",
          error: result.error ?? "Permanent send failure",
          claimedAt: null,
          completedAt: now,
        })
        .where(eq(introductionDeliveries.id, delivery.id));
      failed += 1;
      continue;
    }

    if (delivery.attemptCount >= MAX_ATTEMPTS) {
      await db
        .update(introductionDeliveries)
        .set({
          status: "failed",
          error: `Retry limit reached: ${result.error ?? "transient failure"}`,
          claimedAt: null,
          completedAt: now,
        })
        .where(eq(introductionDeliveries.id, delivery.id));
      failed += 1;
      continue;
    }

    deferred += 1;
    await deferDelivery(db, delivery, result.error ?? "Transient send failure", now);
  }

  if (failed > 0) {
    await db
      .update(introductionGroups)
      .set({ status: "failed", sendError: "Delivery failure", claimedAt: null })
      .where(eq(introductionGroups.id, group.id));
    log(`Group ${group.id} failed (${failed} failed, ${sent} sent, ${deferred} deferred)`);
    await syncRunStatus(db, run.id);
    return { groupId: group.id, runId: run.id, outcome: "failed" };
  }

  if (deferred > 0) {
    await db
      .update(introductionGroups)
      .set({ status: "approved", claimedAt: null, sendError: null })
      .where(eq(introductionGroups.id, group.id));
    log(`Group ${group.id} deferred for retry (${deferred} pending of ${deliveries.length})`);
    return { groupId: group.id, runId: run.id, outcome: "deferred" };
  }

  await db
    .update(introductionGroups)
    .set({ status: "sent", sentAt: now, claimedAt: null, sendError: null })
    .where(eq(introductionGroups.id, group.id));
  log(`Group ${group.id} sent (${sent} recipient(s))`);
  await syncRunStatus(db, run.id);
  return { groupId: group.id, runId: run.id, outcome: "sent" };
}

/**
 * One worker tick: reclaim stale claims, claim up to batchSize groups, send
 * them in a single provider batch, and persist per-delivery results.
 * Never sends anything when live is false.
 */
export async function processDeliveryBatch(
  deps: DeliveryQueueDeps,
  options: { batchSize?: number } = {}
): Promise<DeliveryTickResult> {
  const db = deps.db;
  const now = deps.now ?? new Date();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  if (!deps.live) {
    deps.log("Worker tick skipped: introductions are not live");
    return {
      processed: false,
      skipped: true,
      reason: "read_only",
      claimed: 0,
      sent: 0,
      failed: 0,
      deferred: 0,
      reclaimed: 0,
      staleGroupsReset: 0,
    };
  }

  const stale = await resetStaleClaims(db, { now });
  if (stale.deliveries > 0 || stale.groups > 0) {
    deps.log(`Reclaimed ${stale.deliveries} delivery(ies) and ${stale.groups} group(s) from stale claims`);
  }

  const global = await getGlobalIntroductionConfig(db);
  const senderFrom = global.senderFrom;

  const claimed: ClaimedGroup[] = [];
  for (let i = 0; i < batchSize; i++) {
    const claim = await claimGroup(db, now);
    if (!claim) break;
    await db.execute(
      sql`UPDATE introduction_deliveries
          SET status = 'processing', claimed_at = ${now}, attempt_count = attempt_count + 1
          WHERE group_id = ${claim.groupId} AND status = 'pending'`
    );
    const loaded = await loadClaimedGroup(db, claim.groupId, claim.runId);
    if (loaded && loaded.deliveries.length > 0) {
      claimed.push(loaded);
    } else if (loaded) {
      // No pending deliveries left — nothing to send.
      await db
        .update(introductionGroups)
        .set({ status: "sent", claimedAt: null })
        .where(eq(introductionGroups.id, claim.groupId));
    }
  }

  if (claimed.length === 0) {
    return {
      processed: true,
      skipped: false,
      reason: null,
      claimed: 0,
      sent: 0,
      failed: 0,
      deferred: 0,
      reclaimed: stale.deliveries,
      staleGroupsReset: stale.groups,
    };
  }

  deps.log(`Claimed ${claimed.length} group(s); sending via provider batch...`);

  /**
   * Production runs send one email PER MEMBER: `to` is that member only,
   * `cc`/`replyTo` are the other group members (self excluded) so
   * "Reply all" reaches the group without replying to yourself. Redirected
   * modes (canary/provider_test/simulation) keep the single group message
   * because every delivery targets the same redirect address.
   */
  const messages: GroupEmailMessage[] = [];
  const messageMeta: Array<{ groupId: string; deliveryId: string; messageIndex: number }> = [];
  for (const { group, run, deliveries } of claimed) {
    const subject =
      group.emailSubjectSnapshot ?? `Introductions for ${group.cityName ?? "your city"}`;
    const html = group.emailHtmlSnapshot ?? "";
    const addresses = [...new Set(deliveries.map((d) => d.deliverToEmail))];

    if (run.deliveryMode === "production") {
      for (const delivery of deliveries) {
        const self = delivery.deliverToEmail.trim().toLowerCase();
        const others = addresses.filter((addr) => addr.trim().toLowerCase() !== self);
        messages.push({
          runId: run.id,
          groupId: group.id,
          to: [delivery.deliverToEmail],
          cc: others,
          from: senderFrom,
          subject,
          html,
          replyTo: others,
          idempotencyKey: `intro-${run.id}-${group.id}-${delivery.id}`,
        });
        messageMeta.push({
          groupId: group.id,
          deliveryId: delivery.id,
          messageIndex: messages.length - 1,
        });
      }
    } else {
      const messageIndex = messages.length;
      messages.push({
        runId: run.id,
        groupId: group.id,
        to: addresses,
        from: senderFrom,
        subject,
        html,
        replyTo: addresses,
        idempotencyKey: `intro-${run.id}-${group.id}`,
      });
      for (const delivery of deliveries) {
        messageMeta.push({ groupId: group.id, deliveryId: delivery.id, messageIndex });
      }
    }
  }

  let results: Array<{ ok: boolean; permanent: boolean; id?: string; error?: string }>;
  try {
    results = await deps.sender.sendBatch(messages);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log(`Batch send crashed (treating as transient): ${message}`);
    results = messages.map(() => ({ ok: false, permanent: false, error: message }));
  }

  let sent = 0;
  let failed = 0;
  let deferred = 0;
  for (const c of claimed) {
    const entries: DeliveryOutcomeEntry[] = [];
    for (const meta of messageMeta) {
      if (meta.groupId !== c.group.id) continue;
      entries.push({
        deliveryId: meta.deliveryId,
        result: results[meta.messageIndex] ?? {
          ok: false,
          permanent: false,
          error: "No batch result",
        },
      });
    }
    const outcome = await applyDeliveryResults(db, c, entries, now, deps.log);
    if (outcome.outcome === "sent") sent += 1;
    if (outcome.outcome === "failed") failed += 1;
    if (outcome.outcome === "deferred") deferred += 1;
  }

  return {
    processed: true,
    skipped: false,
    reason: null,
    claimed: claimed.length,
    sent,
    failed,
    deferred,
    reclaimed: stale.deliveries,
    staleGroupsReset: stale.groups,
  };
}

/** Build a queue sender from a Resend client. */
export function resendGroupEmailSender(resend: {
  sendBatch: (messages: ResendBatchMessage[]) => Promise<Array<{ ok: boolean; permanent: boolean; id: string | null; error: string | null }>>;
}): GroupEmailBatchSender {
  return {
    async sendBatch(messages) {
      const results = await resend.sendBatch(messages);
      return results.map((r) => ({
        ok: r.ok,
        permanent: r.permanent,
        id: r.id ?? undefined,
        error: r.error ?? undefined,
      }));
    },
  };
}
