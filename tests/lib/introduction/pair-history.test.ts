import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import { createTestDb } from "../../helpers/test-db";
import {
  loadPairHistory,
  isPairRecent,
  isMemberRecent,
  pairKeyForEmails,
} from "@/lib/introduction/pair-history";
import {
  introductionRuns,
  introductionGroups,
  introductionGroupMembers,
  matchEvents,
  matchEventMatches,
} from "@/db/schema";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

beforeAll(async () => {
  const test = await createTestDb({ matchmake: true, introduction: true });
  db = test.db;
  close = test.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await db.delete(introductionGroupMembers);
  await db.delete(introductionGroups);
  await db.delete(introductionRuns);
  await db.delete(matchEventMatches);
  await db.delete(matchEvents);
});

function daysAgo(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

async function seedLedgerGroup(emails: string[], createdAt: Date, status = "sent") {
  const runId = `run-${crypto.randomUUID()}`;
  await db.insert(introductionRuns).values({
    id: runId,
    requestId: `req-${runId}`,
    source: "recurring",
    mode: "send",
    dryRun: false,
    status: "completed",
    createdAt,
  });
  const groupId = `grp-${crypto.randomUUID()}`;
  await db.insert(introductionGroups).values({
    id: groupId,
    runId,
    source: "recurring",
    groupFingerprint: `fp-${groupId}`,
    status,
    createdAt,
  });
  for (const email of emails) {
    await db.insert(introductionGroupMembers).values({
      id: `gm-${crypto.randomUUID()}`,
      groupId,
      emailSnapshot: email,
      role: "recurring",
      createdAt,
    });
  }
}

async function seedLegacyEvent(newMemberEmail: string, matchEmails: string[], createdAt: Date, opts: { dryRun?: boolean; deleted?: boolean } = {}) {
  const eventId = `evt-${crypto.randomUUID()}`;
  await db.insert(matchEvents).values({
    id: eventId,
    requestId: `req-${eventId}`,
    mode: opts.dryRun ? "preview" : "send",
    dryRun: opts.dryRun ?? false,
    newMemberEmail,
    createdAt,
    deletedAt: opts.deleted ? daysAgo(0) : null,
  });
  for (const [index, matchEmail] of matchEmails.entries()) {
    await db.insert(matchEventMatches).values({
      id: `mm-${crypto.randomUUID()}`,
      matchEventId: eventId,
      rank: index + 1,
      matchEmail,
      similarityScore: 0.9,
      wasOnSlack: true,
    });
  }
}

describe("loadPairHistory — ledger source", () => {
  it("collects pairs and member emails from the introduction ledger", async () => {
    await seedLedgerGroup(["a@x.com", "b@x.com", "c@x.com"], daysAgo(10));

    const history = await loadPairHistory(db, { pairDays: 30, memberDays: 30 });
    expect(history.recentPairs.has("a@x.com|b@x.com")).toBe(true);
    expect(history.recentPairs.has("a@x.com|c@x.com")).toBe(true);
    expect(history.recentPairs.has("b@x.com|c@x.com")).toBe(true);
    expect(history.recentMemberEmails).toEqual(new Set(["a@x.com", "b@x.com", "c@x.com"]));
  });

  it("excludes ledger groups outside the pair window", async () => {
    await seedLedgerGroup(["old1@x.com", "old2@x.com"], daysAgo(120));

    const history = await loadPairHistory(db, { pairDays: 30, memberDays: 30 });
    expect(history.recentPairs.has("old1@x.com|old2@x.com")).toBe(false);
  });

  it("excludes ledger groups with failed status", async () => {
    await seedLedgerGroup(["fail1@x.com", "fail2@x.com"], daysAgo(2), "failed");
    const history = await loadPairHistory(db, { pairDays: 30, memberDays: 30 });
    expect(history.recentPairs.has("fail1@x.com|fail2@x.com")).toBe(false);
  });
});

describe("loadPairHistory — legacy match_events source", () => {
  it("collects legacy new-member/match pairs", async () => {
    await seedLegacyEvent("new@x.com", ["m1@x.com", "m2@x.com"], daysAgo(20));

    const history = await loadPairHistory(db, { pairDays: 60, memberDays: 60 });
    expect(history.recentPairs.has("m1@x.com|new@x.com")).toBe(true);
    expect(history.recentPairs.has("m2@x.com|new@x.com")).toBe(true);
    expect(history.recentMemberEmails.has("new@x.com")).toBe(true);
  });

  it("excludes legacy dry-runs", async () => {
    await seedLegacyEvent("dry@x.com", ["dm@x.com"], daysAgo(1), { dryRun: true });
    const history = await loadPairHistory(db, { pairDays: 30, memberDays: 30 });
    expect(history.recentPairs.has("dry@x.com|dm@x.com")).toBe(false);
    expect(history.recentMemberEmails.has("dry@x.com")).toBe(false);
  });

  it("excludes soft-deleted legacy events", async () => {
    await seedLegacyEvent("gone@x.com", ["gm@x.com"], daysAgo(1), { deleted: true });
    const history = await loadPairHistory(db, { pairDays: 30, memberDays: 30 });
    expect(history.recentPairs.has("gone@x.com|gm@x.com")).toBe(false);
  });

  it("excludes legacy pairs outside the pair window but keeps member emails in the member window", async () => {
    await seedLegacyEvent("fresh@x.com", ["friend@x.com"], daysAgo(10));

    const history = await loadPairHistory(db, { pairDays: 5, memberDays: 30 });
    expect(history.recentPairs.has("fresh@x.com|friend@x.com")).toBe(false);
    expect(history.recentMemberEmails.has("fresh@x.com")).toBe(true);
    expect(history.recentMemberEmails.has("friend@x.com")).toBe(true);
  });
});

describe("loadPairHistory — union", () => {
  it("merges pairs seen in both ledgers", async () => {
    await seedLedgerGroup(["x@x.com", "y@x.com"], daysAgo(5));
    await seedLegacyEvent("y@x.com", ["z@x.com"], daysAgo(5));

    const history = await loadPairHistory(db, { pairDays: 30, memberDays: 30 });
    expect(history.recentPairs.has("x@x.com|y@x.com")).toBe(true);
    expect(history.recentPairs.has("y@x.com|z@x.com")).toBe(true);
    expect(history.recentMemberEmails).toEqual(new Set(["x@x.com", "y@x.com", "z@x.com"]));
  });
});

describe("helpers", () => {
  it("pairKeyForEmails sorts and lowercases", () => {
    expect(pairKeyForEmails("B@x.com", "a@x.com")).toBe("a@x.com|b@x.com");
  });

  it("isPairRecent / isMemberRecent normalize input", () => {
    const history = {
      recentPairs: new Set(["a@x.com|b@x.com"]),
      recentMemberEmails: new Set(["a@x.com"]),
    };
    expect(isPairRecent(history, "A@X.com ", "b@x.com")).toBe(true);
    expect(isMemberRecent(history, " A@X.com")).toBe(true);
    expect(isPairRecent(history, null, "b@x.com")).toBe(false);
  });
});
