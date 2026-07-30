import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../../helpers/test-db";
import {
  getRecentlyIntroducedEmails,
  getRecentIntroductionPairs,
  getMemberIntroductionStats,
  mergePairMaps,
} from "@/lib/introduction/history";
import { introductionRuns } from "@/db/schema/introduction-runs";
import { introductionGroups } from "@/db/schema/introduction-groups";
import { introductionGroupMembers } from "@/db/schema/introduction-group-members";

async function seedGroup(
  db: TestDb,
  runId: string,
  groupId: string,
  emails: string[],
  opts?: { status?: string; createdAt?: Date }
) {
  await db.insert(introductionRuns).values({
    id: runId,
    requestId: `req-${runId}`,
    source: "recurring",
    mode: "send",
    status: "completed",
  }).onConflictDoNothing();

  await db.insert(introductionGroups).values({
    id: groupId,
    runId,
    source: "recurring",
    cycleId: "recurring-london-2026-07-25",
    groupFingerprint: `fp-${groupId}`,
    status: opts?.status || "sent",
    attemptCount: 1,
    createdAt: opts?.createdAt || new Date(),
  });

  for (const email of emails) {
    await db.insert(introductionGroupMembers).values({
      id: `gm-${groupId}-${email}`,
      groupId,
      emailSnapshot: email,
      role: "recurring",
    });
  }
}

describe("introduction history", () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const harness = await createTestDb({ introduction: true });
    db = harness.db;
    close = harness.close;
  });

  afterEach(async () => {
    await close();
  });

  it("returns empty for empty DB", async () => {
    const emails = await getRecentlyIntroducedEmails(db, 30);
    expect(emails.size).toBe(0);
  });

  it("returns recently introduced emails", async () => {
    await seedGroup(db, "r1", "g1", ["a@t.com", "b@t.com", "c@t.com"]);
    const emails = await getRecentlyIntroducedEmails(db, 30);
    expect(emails.size).toBe(3);
    expect(emails.has("a@t.com")).toBe(true);
  });

  it("excludes groups outside the window", async () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 60);
    await seedGroup(db, "r1", "g1", ["old@t.com"], { createdAt: oldDate });

    const emails = await getRecentlyIntroducedEmails(db, 30);
    expect(emails.size).toBe(0);
  });

  it("only counts sent and sent_tracking_failed", async () => {
    await seedGroup(db, "r1", "g1", ["sent@t.com"], { status: "sent" });
    await seedGroup(db, "r2", "g2", ["tracking@t.com"], { status: "sent_tracking_failed" });
    await seedGroup(db, "r3", "g3", ["failed@t.com"], { status: "failed" });

    const emails = await getRecentlyIntroducedEmails(db, 30);
    expect(emails.has("sent@t.com")).toBe(true);
    expect(emails.has("tracking@t.com")).toBe(true);
    expect(emails.has("failed@t.com")).toBe(false);
  });

  it("builds recent pairs correctly", async () => {
    await seedGroup(db, "r1", "g1", ["a@t.com", "b@t.com", "c@t.com"]);
    const pairs = await getRecentIntroductionPairs(db, 30);

    expect(pairs.size).toBe(3); // (a,b), (a,c), (b,c)
    expect(pairs.has("a@t.com|b@t.com")).toBe(true);
    expect(pairs.has("a@t.com|c@t.com")).toBe(true);
    expect(pairs.has("b@t.com|c@t.com")).toBe(true);
  });

  it("returns member introduction stats", async () => {
    await seedGroup(db, "r1", "g1", ["a@t.com", "b@t.com"]);
    await seedGroup(db, "r2", "g2", ["a@t.com", "c@t.com"]);

    const stats = await getMemberIntroductionStats(db, ["a@t.com", "b@t.com", "d@t.com"]);
    expect(stats.get("a@t.com")).toBe(2);
    expect(stats.get("b@t.com")).toBe(1);
    expect(stats.get("d@t.com")).toBe(0);
  });

  it("mergePairMaps combines correctly", () => {
    const a = new Map<string, Set<string>>();
    a.set("a|b", new Set(["a", "b"]));
    const b = new Map<string, Set<string>>();
    b.set("a|b", new Set(["a", "b"]));
    b.set("c|d", new Set(["c", "d"]));

    const merged = mergePairMaps(a, b);
    expect(merged.size).toBe(2);
    expect(merged.has("a|b")).toBe(true);
    expect(merged.has("c|d")).toBe(true);
  });
});
