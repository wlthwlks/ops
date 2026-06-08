import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "../../helpers/test-db";
import {
  matchEvents,
  matchEventMatches,
  emailDeliveries,
} from "@/db/schema";
import { getMatchmakeKpis } from "@/lib/matchmake/kpis";

// ── Helpers ───────────────────────────────────────────────────────────────────

interface InsertEventOpts {
  id?: string;
  requestId?: string;
  email: string;
  createdAt?: Date;
  dryRun?: boolean;
  deletedAt?: Date | null;
}

async function insertEvent(db: TestDb, opts: InsertEventOpts): Promise<string> {
  const id = opts.id ?? crypto.randomUUID();
  const requestId = opts.requestId ?? `req-${id}`;
  await db.insert(matchEvents).values({
    id,
    requestId,
    mode: "send",
    dryRun: opts.dryRun ?? false,
    newMemberEmail: opts.email,
    createdAt: opts.createdAt ?? new Date(),
    deletedAt: opts.deletedAt ?? null,
  });
  return id;
}

async function insertMatch(
  db: TestDb,
  matchEventId: string,
  email: string,
  rank: number
): Promise<void> {
  await db.insert(matchEventMatches).values({
    id: crypto.randomUUID(),
    matchEventId,
    rank,
    matchEmail: email,
    similarityScore: 0.9,
    wasOnSlack: true,
  });
}

async function insertEmailDelivery(
  db: TestDb,
  matchEventId: string,
  status: string,
  email: string = "recipient@example.com"
): Promise<void> {
  await db.insert(emailDeliveries).values({
    id: crypto.randomUUID(),
    matchEventId,
    recipientEmail: email,
    recipientRole: "match",
    status,
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getMatchmakeKpis", () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const harness = await createTestDb({ matchmake: true });
    db = harness.db;
    close = harness.close;
  });

  afterEach(async () => {
    await close();
  });

  it("empty DB: all counts 0, lastSendAt null, pct null", async () => {
    const kpis = await getMatchmakeKpis(db);

    expect(kpis.matchesSentToday).toBe(0);
    expect(kpis.membersReachedToday).toBe(0);
    expect(kpis.emailSuccessRate).toEqual({ sent: 0, failed: 0, pct: null });
    expect(kpis.lastSendAt).toBeNull();
    expect(kpis.generatedAt).toBeInstanceOf(Date);
  });

  it("counts one event + 3 distinct match emails as 4 unique members reached", async () => {
    const eventId = await insertEvent(db, { email: "new@example.com" });
    await insertMatch(db, eventId, "match1@example.com", 1);
    await insertMatch(db, eventId, "match2@example.com", 2);
    await insertMatch(db, eventId, "match3@example.com", 3);

    const kpis = await getMatchmakeKpis(db);

    expect(kpis.matchesSentToday).toBe(1);
    expect(kpis.membersReachedToday).toBe(4);
    expect(kpis.lastSendAt).toBeInstanceOf(Date);
  });

  it("excludes dry_run events from all counts", async () => {
    // One real event (counts) + one dry-run event (excluded).
    const realId = await insertEvent(db, { email: "real@example.com" });
    await insertMatch(db, realId, "realmatch@example.com", 1);

    const dryId = await insertEvent(db, {
      email: "dry@example.com",
      dryRun: true,
    });
    await insertMatch(db, dryId, "drymatch@example.com", 1);

    const kpis = await getMatchmakeKpis(db);

    expect(kpis.matchesSentToday).toBe(1);
    // Only the real event contributes new@ + realmatch@ = 2 distinct emails.
    expect(kpis.membersReachedToday).toBe(2);
  });

  it("excludes soft-deleted events from all counts", async () => {
    const realId = await insertEvent(db, { email: "real@example.com" });
    await insertMatch(db, realId, "realmatch@example.com", 1);

    const deletedId = await insertEvent(db, {
      email: "deleted@example.com",
      deletedAt: new Date(),
    });
    await insertMatch(db, deletedId, "deletedmatch@example.com", 1);

    const kpis = await getMatchmakeKpis(db);

    expect(kpis.matchesSentToday).toBe(1);
    expect(kpis.membersReachedToday).toBe(2);
  });

  it("emailSuccessRate: 18 sent + 2 failed → pct = 90", async () => {
    const eventId = await insertEvent(db, { email: "owner@example.com" });

    // 18 successful deliveries — mix of sent/delivered counts equally.
    for (let i = 0; i < 10; i++) {
      await insertEmailDelivery(db, eventId, "sent", `s${i}@example.com`);
    }
    for (let i = 0; i < 8; i++) {
      await insertEmailDelivery(db, eventId, "delivered", `d${i}@example.com`);
    }

    // 2 failures — mix across the failure statuses.
    await insertEmailDelivery(db, eventId, "failed", "f1@example.com");
    await insertEmailDelivery(db, eventId, "bounced", "b1@example.com");

    const kpis = await getMatchmakeKpis(db);

    expect(kpis.emailSuccessRate.sent).toBe(18);
    expect(kpis.emailSuccessRate.failed).toBe(2);
    expect(kpis.emailSuccessRate.pct).toBe(90);
  });

  it("lastSendAt reflects the most recent non-deleted, non-dry-run event", async () => {
    const olderAt = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    const newerAt = new Date(Date.now() - 5 * 60 * 1000); // 5m ago

    await insertEvent(db, {
      email: "older@example.com",
      createdAt: olderAt,
    });
    await insertEvent(db, {
      email: "newer@example.com",
      createdAt: newerAt,
    });

    // A more recent dry-run event must NOT be picked up.
    await insertEvent(db, {
      email: "dry@example.com",
      createdAt: new Date(),
      dryRun: true,
    });

    const kpis = await getMatchmakeKpis(db);
    expect(kpis.lastSendAt).toBeInstanceOf(Date);
    // Within 2 seconds of the seeded `newerAt`.
    const diffMs = Math.abs(
      (kpis.lastSendAt as Date).getTime() - newerAt.getTime()
    );
    expect(diffMs).toBeLessThan(2_000);
  });

  it("complained status counted as failed in success rate", async () => {
    const eventId = await insertEvent(db, { email: "x@example.com" });
    await insertEmailDelivery(db, eventId, "delivered", "ok@example.com");
    await insertEmailDelivery(db, eventId, "complained", "bad@example.com");

    const kpis = await getMatchmakeKpis(db);
    expect(kpis.emailSuccessRate.sent).toBe(1);
    expect(kpis.emailSuccessRate.failed).toBe(1);
    expect(kpis.emailSuccessRate.pct).toBe(50);
  });

  it("ignores yesterday's events when computing 'today' counts", async () => {
    // Insert an event with a created_at set to 25 hours ago — should be
    // excluded from today's count but still counted for lastSendAt.
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await insertEvent(db, {
      email: "yesterday@example.com",
      createdAt: longAgo,
    });

    // Sanity: pin sql variable to ensure the SQL helper is reachable.
    expect(sql).toBeDefined();

    const kpis = await getMatchmakeKpis(db);
    expect(kpis.matchesSentToday).toBe(0);
    expect(kpis.membersReachedToday).toBe(0);
    expect(kpis.lastSendAt).toBeInstanceOf(Date);
  });
});
