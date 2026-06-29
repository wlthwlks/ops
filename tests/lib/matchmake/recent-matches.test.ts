import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../../helpers/test-db";
import { matchEvents, matchEventMatches } from "@/db/schema";
import { getRecentlyMatchedEmails } from "@/lib/matchmake/recent-matches";

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

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("getRecentlyMatchedEmails", () => {
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

  it("empty DB returns an empty set", async () => {
    const result = await getRecentlyMatchedEmails(db);
    expect(result.size).toBe(0);
  });

  it("includes both the new member and the matched members (any participation)", async () => {
    const eventId = await insertEvent(db, { email: "new@example.com" });
    await insertMatch(db, eventId, "match1@example.com", 1);
    await insertMatch(db, eventId, "match2@example.com", 2);

    const result = await getRecentlyMatchedEmails(db);

    expect(result.has("new@example.com")).toBe(true);
    expect(result.has("match1@example.com")).toBe(true);
    expect(result.has("match2@example.com")).toBe(true);
    expect(result.size).toBe(3);
  });

  it("lowercases all emails so lookups are case-insensitive", async () => {
    const eventId = await insertEvent(db, { email: "New@Example.com" });
    await insertMatch(db, eventId, "MixedCase@Example.com", 1);

    const result = await getRecentlyMatchedEmails(db);

    expect(result.has("new@example.com")).toBe(true);
    expect(result.has("mixedcase@example.com")).toBe(true);
  });

  it("excludes events older than the 30-day window", async () => {
    const recent = await insertEvent(db, {
      email: "recent@example.com",
      createdAt: daysAgo(10),
    });
    await insertMatch(db, recent, "recentmatch@example.com", 1);

    const old = await insertEvent(db, {
      email: "old@example.com",
      createdAt: daysAgo(45),
    });
    await insertMatch(db, old, "oldmatch@example.com", 1);

    const result = await getRecentlyMatchedEmails(db);

    expect(result.has("recent@example.com")).toBe(true);
    expect(result.has("recentmatch@example.com")).toBe(true);
    expect(result.has("old@example.com")).toBe(false);
    expect(result.has("oldmatch@example.com")).toBe(false);
  });

  it("honours a custom window size", async () => {
    const eventId = await insertEvent(db, {
      email: "sevendays@example.com",
      createdAt: daysAgo(8),
    });
    await insertMatch(db, eventId, "sevenmatch@example.com", 1);

    // Within 30 days but outside a 7-day window.
    const result = await getRecentlyMatchedEmails(db, 7);
    expect(result.has("sevendays@example.com")).toBe(false);
  });

  it("excludes dry-run (preview) events", async () => {
    const real = await insertEvent(db, { email: "real@example.com" });
    await insertMatch(db, real, "realmatch@example.com", 1);

    const dry = await insertEvent(db, {
      email: "dry@example.com",
      dryRun: true,
    });
    await insertMatch(db, dry, "drymatch@example.com", 1);

    const result = await getRecentlyMatchedEmails(db);

    expect(result.has("real@example.com")).toBe(true);
    expect(result.has("realmatch@example.com")).toBe(true);
    expect(result.has("dry@example.com")).toBe(false);
    expect(result.has("drymatch@example.com")).toBe(false);
  });

  it("excludes soft-deleted events", async () => {
    const live = await insertEvent(db, { email: "live@example.com" });
    await insertMatch(db, live, "livematch@example.com", 1);

    const deleted = await insertEvent(db, {
      email: "deleted@example.com",
      deletedAt: new Date(),
    });
    await insertMatch(db, deleted, "deletedmatch@example.com", 1);

    const result = await getRecentlyMatchedEmails(db);

    expect(result.has("live@example.com")).toBe(true);
    expect(result.has("deleted@example.com")).toBe(false);
    expect(result.has("deletedmatch@example.com")).toBe(false);
  });
});
