import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { opRuns } from "@/db/schema";
import { eq } from "drizzle-orm";

describe("op_runs schema", () => {
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

  it("inserts and retrieves a run", () => {
    const inserted = db
      .insert(opRuns)
      .values({ opSlug: "test-op", status: "running" })
      .returning()
      .get();

    expect(inserted.opSlug).toBe("test-op");
    expect(inserted.status).toBe("running");
    expect(inserted.id).toBeGreaterThan(0);
  });

  it("updates status and summary on finish", () => {
    const inserted = db
      .insert(opRuns)
      .values({ opSlug: "test-op", status: "running" })
      .returning()
      .get();

    db.update(opRuns)
      .set({
        status: "success",
        summary: "Processed 5 records",
        finishedAt: new Date().toISOString(),
      })
      .where(eq(opRuns.id, inserted.id))
      .run();

    const updated = db
      .select()
      .from(opRuns)
      .where(eq(opRuns.id, inserted.id))
      .get();

    expect(updated?.status).toBe("success");
    expect(updated?.summary).toBe("Processed 5 records");
    expect(updated?.finishedAt).toBeTruthy();
  });
});
