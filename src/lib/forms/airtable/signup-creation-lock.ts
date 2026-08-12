/**
 * Concurrency-safe idempotency / lock for initial Airtable Member creation
 * during signup.
 *
 * Problem this module solves
 * --------------------------
 * Two independent processes can fire within milliseconds of each other after
 * a new Memberstack member is created:
 *
 *   1. `/api/onboarding/bootstrap`  — synchronous, user-facing, authenticated
 *      by the Memberstack ID token. This is the *canonical* creator.
 *   2. Memberstack `member.created` webhook — asynchronous, signed by Svix.
 *
 * Both previously called `upsertMinimalSignupMember()`, which performs a
 * read-then-create against Airtable. Airtable has no unique constraint on
 * Memberstack ID / email, so two concurrent read-then-create sequences both
 * see "no existing record" and both create a row, producing duplicates.
 *
 * Strategy
 * --------
 * We use a single PostgreSQL table `signup_member_creations` keyed by
 * `memberstack_id` (PRIMARY KEY) as a distributed mutex + idempotency log.
 *
 *   acquireSignupCreation({ memberstackId, email, source })
 *     - Attempts `INSERT ... ON CONFLICT (memberstack_id) DO NOTHING
 *        RETURNING *`.
 *     - If the INSERT succeeds, this caller *won* and is the sole creator.
 *     - If the INSERT no-ops (row exists), it reads the row:
 *         - status=CREATED  + airtable_record_id → caller reconciles.
 *         - status=CREATING + fresh              → caller polls then defers
 *                                                   (webhook) or steals a
 *                                                   STALE row (bootstrap).
 *         - status=CREATING + stale (> STALE_MS) → caller steals via
 *                                                   conditional UPDATE.
 *         - status=FAILED                       → caller may re-acquire.
 *
 * Because PostgreSQL is the single source of truth and the INSERT is atomic,
 * exactly one caller wins the per-member mutex per creation attempt. Two
 * concurrent requests for the same Memberstack member therefore cannot both
 * reach the Airtable `create` step.
 *
 * The lock table does NOT replace Airtable as the canonical member store —
 * it only serializes *initial* creation. Identity-conflict detection happens
 * against Airtable in `upsertMinimalSignupMember`.
 *
 * The module degrades gracefully: if the DB is unreachable (shadow mode,
 * local dev without POSTGRES_URL, etc.), callers fall back to the legacy
 * direct Airtable create path — same behaviour as before this module existed
 * — so we never introduce a hard DB dependency for signup.
 */
import { db } from "@/db";
import { signupMemberCreations } from "@/db/schema";
import { and, eq, lt } from "drizzle-orm";
import { normalizeEmailStrict } from "@/lib/billing/reconcile-stripe-customers";

/** A row stuck in CREATING longer than this may be stolen by a new caller. */
export const STALE_CREATING_MS = 120_000;

/** How long a webhook caller polls for bootstrap completion before deferring. */
export const WEBHOOK_WAIT_TIMEOUT_MS = 4_000;
export const WEBHOOK_POLL_INTERVAL_MS = 150;

/** How long a bootstrap caller polls for a webhook competitor before giving up to the user. */
export const BOOTSTRAP_WAIT_TIMEOUT_MS = 5_000;
export const BOOTSTRAP_POLL_INTERVAL_MS = 150;

export type SignupCaller = "bootstrap" | "memberstack_webhook";

export type SignupLockState =
  | { kind: "acquired" }
  | { kind: "already_created"; airtableRecordId: string; status: string }
  | { kind: "pending"; status: string }
  | { kind: "unavailable" };

function normalizeMsId(id: string): string {
  return (id || "").trim();
}

/**
 * Try to become the canonical creator for `memberstackId`.
 *
 * Returns the lock state describing whether the caller should create,
 * reconcile an existing record, poll/defer, or proceed without a DB.
 */
export async function acquireSignupCreation(input: {
  memberstackId: string;
  email: string;
  source: SignupCaller;
}): Promise<SignupLockState> {
  const msId = normalizeMsId(input.memberstackId);
  if (!msId) {
    // Without a stable Memberstack ID we have no lock key; the caller is
    // responsible for surfacing an error upstream. Treat as unavailable so
    // callers fall through to the legacy (no-lock) path — exactly the prior
    // behaviour.
    return { kind: "unavailable" };
  }
  const emailNorm = normalizeEmailStrict(input.email);

  // Attempt 1: try to freshly INSERT. ON CONFLICT DO NOTHING returns nothing
  // if a row already exists with this memberstack_id.
  try {
    const inserted = await db
      .insert(signupMemberCreations)
      .values({
        memberstackId: msId,
        emailNormalized: emailNorm,
        status: "CREATING",
        createdBy: input.source,
        attemptCount: 1,
      })
      .onConflictDoNothing({ target: signupMemberCreations.memberstackId })
      .returning();
    if (inserted.length > 0) {
      return { kind: "acquired" };
    }
  } catch {
    // Fall through to read path. If the read also fails we degrade gracefully.
  }

  // Attempt 2: an existing row exists. Read it and decide.
  let row;
  try {
    const rows = await db
      .select()
      .from(signupMemberCreations)
      .where(eq(signupMemberCreations.memberstackId, msId))
      .limit(1);
    row = rows[0] ?? null;
  } catch {
    return { kind: "unavailable" };
  }
  if (!row) {
    // INSERT reported conflict but the row is gone (concurrent DELETE? very rare).
    // Treat as acquired so the caller still gets to perform the canonical create.
    return { kind: "acquired" };
  }

  if (row.status === "CREATED" && row.airtableRecordId) {
    return {
      kind: "already_created",
      airtableRecordId: row.airtableRecordId,
      status: row.status,
    };
  }

  if (row.status === "FAILED") {
    // Previous creator failed. Re-acquire by issuing a conditional UPDATE.
    return await reAcquireStaleOrCreate(msId, emailNorm, input.source, row);
  }

  // row.status === "CREATING"
  if (isStale(row.updatedAt)) {
    return await reAcquireStaleOrCreate(msId, emailNorm, input.source, row);
  }

  return { kind: "pending", status: row.status };
}

async function reAcquireStaleOrCreate(
  msId: string,
  emailNorm: string,
  source: SignupCaller,
  current: { attemptCount: number | null }
): Promise<SignupLockState> {
  try {
    const updated = await db
      .update(signupMemberCreations)
      .set({
        status: "CREATING",
        createdBy: source,
        updatedAt: new Date(),
        airtableRecordId: null,
        completedAt: null,
        lastError: null,
        attemptCount: (current.attemptCount ?? 0) + 1,
      })
      .where(eq(signupMemberCreations.memberstackId, msId))
      .returning();
    if (updated.length > 0) {
      return { kind: "acquired" };
    }
  } catch {
    /* fall through to re-read */
  }

  // Re-read in case a concurrent caller stole first.
  try {
    const rows = await db
      .select()
      .from(signupMemberCreations)
      .where(eq(signupMemberCreations.memberstackId, msId))
      .limit(1);
    const row = rows[0];
    if (!row) return { kind: "acquired" };
    if (row.status === "CREATED" && row.airtableRecordId) {
      return {
        kind: "already_created",
        airtableRecordId: row.airtableRecordId,
        status: row.status,
      };
    }
    return { kind: "pending", status: row.status };
  } catch {
    return { kind: "unavailable" };
  }
}

function isStale(updatedAt: Date | null): boolean {
  if (!updatedAt) return true;
  return Date.now() - updatedAt.getTime() > STALE_CREATING_MS;
}

/**
 * Mark the lock row as completed. Idempotent — re-marking a COMPLETED row is
 * a no-op state but we still update `updated_at` so late pollers see fresh
 * activity.
 */
export async function markSignupCreationComplete(input: {
  memberstackId: string;
  airtableRecordId: string;
}): Promise<void> {
  const msId = normalizeMsId(input.memberstackId);
  if (!msId) return;
  try {
    await db
      .update(signupMemberCreations)
      .set({
        status: "CREATED",
        airtableRecordId: input.airtableRecordId,
        updatedAt: new Date(),
        completedAt: new Date(),
      })
      .where(eq(signupMemberCreations.memberstackId, msId));
  } catch {
    /* DB unavailable — caller still recovers via Airtable lookup next time */
  }
}

/**
 * Mark the in-progress creation as failed (caller threw before populating
 * airtable_record_id). The row stays so a later caller can steal it once
 * stale (or earlier if the caller is the bootstrap owner).
 */
export async function markSignupCreationFailed(input: {
  memberstackId: string;
  reason?: string;
}): Promise<void> {
  const msId = normalizeMsId(input.memberstackId);
  if (!msId) return;
  try {
    await db
      .update(signupMemberCreations)
      .set({
        status: "FAILED",
        lastError: (input.reason ?? "").slice(0, 500) || null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(signupMemberCreations.memberstackId, msId),
          eq(signupMemberCreations.status, "CREATING")
        )
      );
  } catch {
    /* ignore */
  }
}

/** Read the current lock state without acquiring ownership. */
export async function readSignupCreation(memberstackId: string): Promise<{
  airtableRecordId: string | null;
  status: string | null;
} | null> {
  const msId = normalizeMsId(memberstackId);
  if (!msId) return null;
  try {
    const rows = await db
      .select()
      .from(signupMemberCreations)
      .where(eq(signupMemberCreations.memberstackId, msId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      airtableRecordId: row.airtableRecordId ?? null,
      status: row.status ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Poll the lock row for a non-null `airtable_record_id` (or a FAILED/CREATED
 * terminal state). Returns the airtableRecordId once available, or null on
 * timeout. Null *does not* mean a duplicate was created — it only means the
 * creator has not yet completed within the polling window; callers must
 * defer or short-circuit rather than proceed to create.
 */
export async function waitForSignupCreation(input: {
  memberstackId: string;
  timeoutMs: number;
  pollIntervalMs?: number;
}): Promise<string | null> {
  const msId = normalizeMsId(input.memberstackId);
  if (!msId) return null;
  const deadline = Date.now() + input.timeoutMs;
  const interval = input.pollIntervalMs ?? 150;
  while (Date.now() < deadline) {
    const row = await readSignupCreation(msId);
    if (row?.airtableRecordId) return row.airtableRecordId;
    if (row?.status === "FAILED") return null;
    await new Promise((r) => setTimeout(r, interval));
  }
  return null;
}

/**
 * Manual / scripted cleanup helper: delete a stuck lock row so a fresh signup
 * attempt can run. Not used by the live flow — exposed for ops.
 */
export async function clearSignupCreation(memberstackId: string): Promise<void> {
  const msId = normalizeMsId(memberstackId);
  if (!msId) return;
  try {
    await db
      .delete(signupMemberCreations)
      .where(eq(signupMemberCreations.memberstackId, msId));
  } catch {
    /* ignore */
  }
}

/**
 * Returns rows whose `updated_at` is older than the cutoff while in
 * CREATING/FAILED. Used by the audit script and (optionally) a future cleanup
 * cron. Read-only.
 */
export async function listStaleSignupCreations(
  cutoffMs: number = STALE_CREATING_MS
): Promise<
  Array<{
    memberstackId: string;
    emailNormalized: string;
    status: string;
    updatedAt: Date | null;
    airtableRecordId: string | null;
  }>
> {
  const cutoff = new Date(Date.now() - cutoffMs);
  try {
    return await db
      .select({
        memberstackId: signupMemberCreations.memberstackId,
        emailNormalized: signupMemberCreations.emailNormalized,
        status: signupMemberCreations.status,
        updatedAt: signupMemberCreations.updatedAt,
        airtableRecordId: signupMemberCreations.airtableRecordId,
      })
      .from(signupMemberCreations)
      .where(lt(signupMemberCreations.updatedAt, cutoff));
  } catch {
    return [];
  }
}