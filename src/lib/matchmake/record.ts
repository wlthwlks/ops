import type { AppDb } from "@/db";
import {
  members,
  matchEvents,
  matchEventMatches,
  emailDeliveries,
} from "@/db/schema";
import { eq, sql } from "drizzle-orm";

export interface MemberInput {
  email: string;
  postcode?: string;
  city?: string;
  industry?: string;
  airtableRecordId?: string;
  pineconeId?: string;
}

export interface MatchInput extends MemberInput {
  rank: number; // 1-based, up to 5
  similarityScore: number; // 0-1
  wasOnSlack: boolean;
}

export interface RecordMatchEventInput {
  db: AppDb;
  requestId: string;
  mode: "send" | "send-slack" | "send-email" | "preview";
  dryRun: boolean;
  initiatedBy?: string;
  newMember: MemberInput;
  matches: MatchInput[];
}

export interface RecordMatchEventResult {
  matchEventId: string;
  newMemberId: string;
  matchMemberIds: string[];
  isDuplicate: boolean;
}

function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Upserts a member by email. If the email already exists the row is returned
 * unchanged, except that `airtable_record_id` / `pinecone_id` are updated
 * when the input supplies non-null values.
 *
 * NOTE — @neondatabase/serverless HTTP driver does NOT support multi-statement
 * transactions over HTTP (the driver sends each statement as a separate HTTP
 * request; `db.transaction(…)` is not available on the HTTP variant).  Writes
 * are therefore ordered so a partial failure leaves a consistent state:
 *   1. members upserts (idempotent, safe to retry)
 *   2. match_events insert (idempotent via ON CONFLICT DO NOTHING)
 *   3. match_event_matches inserts (only reached when event is fresh)
 * If step 3 fails the event row exists with zero match rows; callers can
 * detect this via `SELECT count(*) FROM match_event_matches WHERE
 * match_event_id = $id` and retry the full call (steps 1-2 are no-ops on
 * retry, step 3 will be re-attempted).
 */
async function upsertMember(
  db: AppDb,
  input: MemberInput
): Promise<string> {
  const email = normaliseEmail(input.email);
  const id = crypto.randomUUID();

  const rows = await db
    .insert(members)
    .values({
      id,
      email,
      airtableRecordId: input.airtableRecordId ?? null,
      pineconeId: input.pineconeId ?? null,
    })
    .onConflictDoUpdate({
      target: members.email,
      set: {
        // Touch email-to-itself so RETURNING always returns the existing row.
        email: sql`EXCLUDED.email`,
        // Only overwrite if the caller supplied a value.
        ...(input.airtableRecordId != null
          ? { airtableRecordId: input.airtableRecordId }
          : {}),
        ...(input.pineconeId != null ? { pineconeId: input.pineconeId } : {}),
      },
    })
    .returning({ id: members.id });

  const row = rows[0];
  if (!row) {
    throw new Error(`upsertMember: no row returned for email ${email}`);
  }
  return row.id;
}

/**
 * Records a full match event, upserting member rows and inserting the event
 * and its match rows.
 *
 * Idempotent: if `requestId` already exists the function returns the existing
 * result with `isDuplicate: true` and writes nothing further.
 *
 * See the module-level NOTE above for transaction behaviour on the Neon HTTP
 * driver.
 */
export async function recordMatchEvent(
  i: RecordMatchEventInput
): Promise<RecordMatchEventResult> {
  const {
    db,
    requestId,
    mode,
    dryRun,
    initiatedBy,
    newMember,
    matches,
  } = i;

  // ── 1. Upsert all members (idempotent) ─────────────────────────────────
  const newMemberId = await upsertMember(db, newMember);

  const matchMemberIds: string[] = [];
  for (const match of matches) {
    const mid = await upsertMember(db, match);
    matchMemberIds.push(mid);
  }

  // ── 2. Insert match_events (idempotent via ON CONFLICT DO NOTHING) ──────
  const eventId = crypto.randomUUID();

  const insertedEvents = await db
    .insert(matchEvents)
    .values({
      id: eventId,
      requestId,
      mode,
      dryRun,
      initiatedBy: initiatedBy ?? null,
      newMemberId,
      newMemberEmail: normaliseEmail(newMember.email),
      newMemberPostcode: newMember.postcode ?? null,
      newMemberCity: newMember.city ?? null,
      newMemberIndustry: newMember.industry ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: matchEvents.id });

  // ── 3a. Duplicate detection ─────────────────────────────────────────────
  if (insertedEvents.length === 0) {
    // Event already existed — fetch its id and existing match member ids.
    const [existingEvent] = await db
      .select({ id: matchEvents.id, newMemberId: matchEvents.newMemberId })
      .from(matchEvents)
      .where(eq(matchEvents.requestId, requestId));

    if (!existingEvent) {
      throw new Error(
        `recordMatchEvent: ON CONFLICT DO NOTHING returned nothing but ` +
          `subsequent lookup also found no row for requestId=${requestId}`
      );
    }

    const existingMatchRows = await db
      .select({ matchMemberId: matchEventMatches.matchMemberId })
      .from(matchEventMatches)
      .where(eq(matchEventMatches.matchEventId, existingEvent.id));

    const existingMatchMemberIds = existingMatchRows
      .map((r) => r.matchMemberId)
      .filter((id): id is string => id != null);

    return {
      matchEventId: existingEvent.id,
      newMemberId: existingEvent.newMemberId ?? newMemberId,
      matchMemberIds: existingMatchMemberIds,
      isDuplicate: true,
    };
  }

  const matchEventId = insertedEvents[0]!.id;

  // ── 3b. Insert match_event_matches ──────────────────────────────────────
  if (matches.length > 0) {
    const matchRows = matches.map((match, idx) => ({
      id: crypto.randomUUID(),
      matchEventId,
      rank: match.rank,
      matchMemberId: matchMemberIds[idx]!,
      matchEmail: normaliseEmail(match.email),
      matchPostcode: match.postcode ?? null,
      matchCity: match.city ?? null,
      matchIndustry: match.industry ?? null,
      similarityScore: match.similarityScore,
      wasOnSlack: match.wasOnSlack,
    }));

    await db.insert(matchEventMatches).values(matchRows);
  }

  return {
    matchEventId,
    newMemberId,
    matchMemberIds,
    isDuplicate: false,
  };
}

/**
 * Updates the parent match_event with Slack delivery metadata and stamps
 * `slack_sent_at`.
 */
export async function recordSlackDelivery(
  db: AppDb,
  matchEventId: string,
  d: {
    slackChannelId: string;
    slackMessageTs?: string;
    slackRecipientCount: number;
  }
): Promise<void> {
  await db
    .update(matchEvents)
    .set({
      slackChannelId: d.slackChannelId,
      slackMessageTs: d.slackMessageTs ?? null,
      slackRecipientCount: d.slackRecipientCount,
      slackSentAt: new Date(),
    })
    .where(eq(matchEvents.id, matchEventId));
}

/**
 * Inserts one email_deliveries row per call.
 */
export async function recordEmailDelivery(
  db: AppDb,
  matchEventId: string,
  d: {
    recipientEmail: string;
    recipientRole: "new_member" | "match";
    resendMessageId?: string;
    status: "sent" | "failed";
    error?: string;
  }
): Promise<void> {
  await db.insert(emailDeliveries).values({
    id: crypto.randomUUID(),
    matchEventId,
    recipientEmail: normaliseEmail(d.recipientEmail),
    recipientRole: d.recipientRole,
    resendMessageId: d.resendMessageId ?? null,
    status: d.status,
    error: d.error ?? null,
  });
}
