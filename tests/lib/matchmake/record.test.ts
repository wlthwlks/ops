import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, count } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../helpers/test-db";
import {
  recordMatchEvent,
  recordSlackDelivery,
  recordEmailDelivery,
} from "@/lib/matchmake/record";
import {
  members,
  matchEvents,
  matchEventMatches,
  emailDeliveries,
} from "@/db/schema";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_NEW_MEMBER = {
  email: "alice@example.com",
  postcode: "EC1A1BB",
  city: "London",
  industry: "FinTech",
};

const BASE_MATCH: typeof BASE_NEW_MEMBER & {
  rank: number;
  similarityScore: number;
  wasOnSlack: boolean;
} = {
  email: "bob@example.com",
  postcode: "W1A0AX",
  city: "London",
  industry: "SaaS",
  rank: 1,
  similarityScore: 0.92,
  wasOnSlack: true,
};

const BASE_INPUT = {
  requestId: "req-001",
  mode: "send" as const,
  dryRun: false,
  initiatedBy: "cron",
  newMember: BASE_NEW_MEMBER,
  matches: [BASE_MATCH],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setup() {
  return createTestDb({ matchmake: true });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("recordMatchEvent", () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const harness = await setup();
    db = harness.db;
    close = harness.close;
  });

  afterEach(async () => {
    await close();
  });

  // 1. Happy path ─────────────────────────────────────────────────────────────
  it("happy path: writes event + matches and returns correct IDs", async () => {
    const result = await recordMatchEvent({ db, ...BASE_INPUT });

    expect(result.isDuplicate).toBe(false);
    expect(result.matchEventId).toBeTruthy();
    expect(result.newMemberId).toBeTruthy();
    expect(result.matchMemberIds).toHaveLength(1);
    expect(result.matchMemberIds[0]).toBeTruthy();

    // Event row exists
    const [event] = await db
      .select()
      .from(matchEvents)
      .where(eq(matchEvents.id, result.matchEventId));
    expect(event?.requestId).toBe("req-001");
    expect(event?.newMemberEmail).toBe("alice@example.com");
    expect(event?.mode).toBe("send");
    expect(event?.dryRun).toBe(false);

    // Match row exists
    const matchRows = await db
      .select()
      .from(matchEventMatches)
      .where(eq(matchEventMatches.matchEventId, result.matchEventId));
    expect(matchRows).toHaveLength(1);
    expect(matchRows[0]?.matchEmail).toBe("bob@example.com");
    expect(matchRows[0]?.rank).toBe(1);
    expect(matchRows[0]?.similarityScore).toBeCloseTo(0.92, 2);
    expect(matchRows[0]?.wasOnSlack).toBe(true);
  });

  // 2. Idempotency (same request_id) ─────────────────────────────────────────
  it("returns isDuplicate: true on second call with same requestId", async () => {
    const first = await recordMatchEvent({ db, ...BASE_INPUT });
    const second = await recordMatchEvent({
      db,
      ...BASE_INPUT,
      requestId: "req-001",
    });

    expect(second.isDuplicate).toBe(true);
    expect(second.matchEventId).toBe(first.matchEventId);

    // No duplicate event rows
    const [row] = await db
      .select({ n: count() })
      .from(matchEvents)
      .where(eq(matchEvents.requestId, "req-001"));
    expect(row?.n).toBe(1);

    // No duplicate match rows
    const [matchRow] = await db
      .select({ n: count() })
      .from(matchEventMatches)
      .where(eq(matchEventMatches.matchEventId, first.matchEventId));
    expect(matchRow?.n).toBe(1);
  });

  // 3. Member upsert idempotency ──────────────────────────────────────────────
  it("same email in two separate events creates only one members row", async () => {
    await recordMatchEvent({ db, ...BASE_INPUT, requestId: "req-A" });
    await recordMatchEvent({ db, ...BASE_INPUT, requestId: "req-B" });

    const [row] = await db
      .select({ n: count() })
      .from(members)
      .where(eq(members.email, "alice@example.com"));
    expect(row?.n).toBe(1);
  });

  // 4. Postcode preserved on match rows ──────────────────────────────────────
  it("preserves match postcode on match_event_matches", async () => {
    const result = await recordMatchEvent({ db, ...BASE_INPUT });

    const [matchRow] = await db
      .select()
      .from(matchEventMatches)
      .where(eq(matchEventMatches.matchEventId, result.matchEventId));

    expect(matchRow?.matchPostcode).toBe("W1A0AX");
  });

  // 5. dryRun flag stored ─────────────────────────────────────────────────────
  it("stores dry_run = true when dryRun is true", async () => {
    const result = await recordMatchEvent({
      db,
      ...BASE_INPUT,
      requestId: "req-dry",
      dryRun: true,
    });

    const [event] = await db
      .select()
      .from(matchEvents)
      .where(eq(matchEvents.id, result.matchEventId));

    expect(event?.dryRun).toBe(true);
  });

  // 8. Email normalised to lowercase + trimmed ────────────────────────────────
  it("normalises email to lowercase and trims whitespace", async () => {
    const result = await recordMatchEvent({
      db,
      requestId: "req-norm",
      mode: "send",
      dryRun: false,
      newMember: { email: "  CHARLIE@Example.COM  " },
      matches: [
        {
          email: "  DAVE@Example.COM  ",
          rank: 1,
          similarityScore: 0.8,
          wasOnSlack: false,
        },
      ],
    });

    const [memberRow] = await db
      .select()
      .from(members)
      .where(eq(members.email, "charlie@example.com"));
    expect(memberRow).toBeTruthy();

    const [matchRow] = await db
      .select()
      .from(matchEventMatches)
      .where(eq(matchEventMatches.matchEventId, result.matchEventId));
    expect(matchRow?.matchEmail).toBe("dave@example.com");
  });
});

// ── recordSlackDelivery ───────────────────────────────────────────────────────

describe("recordSlackDelivery", () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const harness = await setup();
    db = harness.db;
    close = harness.close;
  });

  afterEach(async () => {
    await close();
  });

  // 6. Slack delivery fields + slack_sent_at ─────────────────────────────────
  it("updates slack fields and stamps slack_sent_at", async () => {
    const { matchEventId } = await recordMatchEvent({
      db,
      ...BASE_INPUT,
      requestId: "req-slack",
    });

    await recordSlackDelivery(db, matchEventId, {
      slackChannelId: "C01234567",
      slackMessageTs: "1718000000.000100",
      slackRecipientCount: 5,
    });

    const [event] = await db
      .select()
      .from(matchEvents)
      .where(eq(matchEvents.id, matchEventId));

    expect(event?.slackChannelId).toBe("C01234567");
    expect(event?.slackMessageTs).toBe("1718000000.000100");
    expect(event?.slackRecipientCount).toBe(5);
    expect(event?.slackSentAt).toBeInstanceOf(Date);
  });
});

// ── recordEmailDelivery ───────────────────────────────────────────────────────

describe("recordEmailDelivery", () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const harness = await setup();
    db = harness.db;
    close = harness.close;
  });

  afterEach(async () => {
    await close();
  });

  // 7. Email delivery rows round-trip correctly ───────────────────────────────
  it("inserts one row per call; recipient role and status round-trip", async () => {
    const { matchEventId } = await recordMatchEvent({
      db,
      ...BASE_INPUT,
      requestId: "req-email",
    });

    await recordEmailDelivery(db, matchEventId, {
      recipientEmail: "alice@example.com",
      recipientRole: "new_member",
      resendMessageId: "resend-msg-001",
      status: "sent",
    });

    await recordEmailDelivery(db, matchEventId, {
      recipientEmail: "bob@example.com",
      recipientRole: "match",
      status: "failed",
      error: "mailbox full",
    });

    const rows = await db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.matchEventId, matchEventId));

    expect(rows).toHaveLength(2);

    const alice = rows.find((r) => r.recipientEmail === "alice@example.com");
    expect(alice?.recipientRole).toBe("new_member");
    expect(alice?.status).toBe("sent");
    expect(alice?.resendMessageId).toBe("resend-msg-001");

    const bob = rows.find((r) => r.recipientEmail === "bob@example.com");
    expect(bob?.recipientRole).toBe("match");
    expect(bob?.status).toBe("failed");
    expect(bob?.error).toBe("mailbox full");
  });
});
