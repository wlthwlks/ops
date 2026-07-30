import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, type TestDb } from "../../helpers/test-db";
import {
  reserveMembers,
  releaseReservations,
  deleteExpiredReservations,
  findReservationConflicts,
} from "@/lib/introduction/reservations";
import { eq } from "drizzle-orm";
import { introductionReservations } from "@/db/schema/introduction-reservations";
import { introductionRuns } from "@/db/schema/introduction-runs";
import { introductionGroups } from "@/db/schema/introduction-groups";

async function ensureGroup(db: TestDb, groupId: string) {
  const runId = `r-${groupId}`;
  await db.insert(introductionRuns).values({
    id: runId, requestId: `req-${runId}`, source: "recurring", mode: "send", status: "completed",
  }).onConflictDoNothing();
  await db.insert(introductionGroups).values({
    id: groupId, runId, source: "recurring", groupFingerprint: `fp-${groupId}`, status: "planned",
  }).onConflictDoNothing();
}

describe("introduction reservations", () => {
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

  it("reserves members successfully", async () => {
    await ensureGroup(db, "g1");
    const future = new Date(Date.now() + 3600000);
    const { reserved, conflicts } = await reserveMembers(
      db, "g1", "recurring",
      [{ airtableRecordId: "rec_1", email: "a@t.com" }],
      future
    );
    expect(reserved).toHaveLength(1);
    expect(conflicts).toHaveLength(0);
  });

  it("detects reservation conflicts", async () => {
    await ensureGroup(db, "g1");
    await ensureGroup(db, "g2");
    const future = new Date(Date.now() + 3600000);

    const r1 = await reserveMembers(db, "g1", "recurring", [{ airtableRecordId: "rec_1" }], future);
    expect(r1.conflicts).toHaveLength(0);

    const r2 = await reserveMembers(db, "g2", "recurring", [{ airtableRecordId: "rec_1" }], future);
    expect(r2.conflicts).toHaveLength(1);
    expect(r2.reserved).toHaveLength(0);
  });

  it("releases reservations for a group", async () => {
    await ensureGroup(db, "g1");
    const future = new Date(Date.now() + 3600000);
    await reserveMembers(db, "g1", "recurring", [{ airtableRecordId: "rec_1" }, { airtableRecordId: "rec_2" }], future);

    const released = await releaseReservations(db, "g1");
    expect(released).toBe(2);
  });

  it("deletes expired reservations", async () => {
    await ensureGroup(db, "g1");
    const past = new Date(Date.now() - 3600000);
    await reserveMembers(db, "g1", "recurring", [{ airtableRecordId: "rec_expired" }], past);

    const deleted = await deleteExpiredReservations(db);
    expect(deleted).toBe(1);

    const rows = await db.select().from(introductionReservations);
    expect(rows).toHaveLength(0);
  });

  it("findReservationConflicts returns keys of reserved members", async () => {
    await ensureGroup(db, "g1");
    const future = new Date(Date.now() + 3600000);
    await reserveMembers(db, "g1", "recurring", [{ airtableRecordId: "rec_1" }], future);

    const conflicts = await findReservationConflicts(db, [{ airtableRecordId: "rec_1" }]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toBe("at:rec_1");
  });

  it("excludes own group from conflict check", async () => {
    await ensureGroup(db, "g1");
    const future = new Date(Date.now() + 3600000);
    await reserveMembers(db, "g1", "recurring", [{ airtableRecordId: "rec_1" }], future);

    const conflicts = await findReservationConflicts(db, [{ airtableRecordId: "rec_1" }], "g1");
    expect(conflicts).toHaveLength(0);
  });

  it("email-based keys work", async () => {
    await ensureGroup(db, "g1");
    const future = new Date(Date.now() + 3600000);
    const { reserved } = await reserveMembers(
      db, "g1", "onboarding",
      [{ email: "test@example.com" }],
      future
    );
    expect(reserved).toHaveLength(1);
  });
});
