import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { runOp } from "@/lib/run-op";
import { opRuns } from "@/db/schema";
import type { Op } from "@/lib/types";

describe("runOp", () => {
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

  it("runs a successful op and records history", async () => {
    const op: Op = {
      slug: "test-op",
      name: "Test",
      description: "test",
      run: async (ctx) => {
        ctx.log("working");
        return { success: true, summary: "done", recordsProcessed: 3 };
      },
    };

    const result = await runOp(op, db);
    expect(result.success).toBe(true);
    expect(result.summary).toBe("done");

    const runs = db.select().from(opRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("success");
    expect(runs[0].log).toContain("working");
  });

  it("catches op errors and records failure", async () => {
    const op: Op = {
      slug: "failing-op",
      name: "Fail",
      description: "fails",
      run: async () => {
        throw new Error("connection refused");
      },
    };

    const result = await runOp(op, db);
    expect(result.success).toBe(false);
    expect(result.summary).toContain("connection refused");

    const runs = db.select().from(opRuns).all();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
  });
});
