import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRunLogger } from "@/lib/logger";
import { opRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/test-db";

describe("RunLogger", () => {
  let db: TestDb;
  let close: () => Promise<void>;

  beforeEach(async () => {
    const harness = await createTestDb();
    db = harness.db;
    close = harness.close;
  });

  afterEach(async () => {
    await close();
  });

  it("starts a run and returns a context with log function", async () => {
    const { ctx, runId } = await createRunLogger(db, "test-op");
    expect(runId).toBeGreaterThan(0);
    expect(typeof ctx.log).toBe("function");
    expect(ctx.db).toBe(db);
  });

  it("appends log messages to the run record", async () => {
    const { ctx, runId } = await createRunLogger(db, "test-op");
    await ctx.log("first message");
    await ctx.log("second message");
    const [run] = await db.select().from(opRuns).where(eq(opRuns.id, runId));
    expect(run?.log).toContain("first message");
    expect(run?.log).toContain("second message");
  });

  it("finishRun marks success with summary", async () => {
    const { ctx, runId, finishRun } = await createRunLogger(db, "test-op");
    await ctx.log("did some work");
    await finishRun({ success: true, summary: "Processed 10 records" });
    const [run] = await db.select().from(opRuns).where(eq(opRuns.id, runId));
    expect(run?.status).toBe("success");
    expect(run?.summary).toBe("Processed 10 records");
    expect(run?.finishedAt).toBeTruthy();
  });

  it("finishRun marks failure", async () => {
    const { runId, finishRun } = await createRunLogger(db, "test-op");
    await finishRun({ success: false, summary: "Connection timeout" });
    const [run] = await db.select().from(opRuns).where(eq(opRuns.id, runId));
    expect(run?.status).toBe("failed");
    expect(run?.summary).toBe("Connection timeout");
  });
});
