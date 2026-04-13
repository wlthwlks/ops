import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { createRunLogger } from "@/lib/logger";
import { opRuns } from "@/db/schema";
import { eq } from "drizzle-orm";

describe("RunLogger", () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);
    sqlite.exec(`
      CREATE TABLE op_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        op_slug TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        log TEXT NOT NULL DEFAULT '',
        summary TEXT
      )
    `);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("starts a run and returns a context with log function", () => {
    const { ctx, runId } = createRunLogger(db, "test-op");
    expect(runId).toBeGreaterThan(0);
    expect(typeof ctx.log).toBe("function");
    expect(ctx.db).toBe(db);
  });

  it("appends log messages to the run record", () => {
    const { ctx, runId } = createRunLogger(db, "test-op");
    ctx.log("first message");
    ctx.log("second message");
    const run = db.select().from(opRuns).where(eq(opRuns.id, runId)).get();
    expect(run?.log).toContain("first message");
    expect(run?.log).toContain("second message");
  });

  it("finishRun marks success with summary", () => {
    const { ctx, runId, finishRun } = createRunLogger(db, "test-op");
    ctx.log("did some work");
    finishRun({ success: true, summary: "Processed 10 records" });
    const run = db.select().from(opRuns).where(eq(opRuns.id, runId)).get();
    expect(run?.status).toBe("success");
    expect(run?.summary).toBe("Processed 10 records");
    expect(run?.finishedAt).toBeTruthy();
  });

  it("finishRun marks failure", () => {
    const { runId, finishRun } = createRunLogger(db, "test-op");
    finishRun({ success: false, summary: "Connection timeout" });
    const run = db.select().from(opRuns).where(eq(opRuns.id, runId)).get();
    expect(run?.status).toBe("failed");
    expect(run?.summary).toBe("Connection timeout");
  });
});
