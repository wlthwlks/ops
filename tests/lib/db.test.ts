import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { opRuns } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/test-db";

describe("op_runs schema", () => {
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

  it("inserts and retrieves a run", async () => {
    const [inserted] = await db
      .insert(opRuns)
      .values({ opSlug: "test-op", status: "running" })
      .returning();

    expect(inserted.opSlug).toBe("test-op");
    expect(inserted.status).toBe("running");
    expect(inserted.id).toBeGreaterThan(0);
  });

  it("updates status and summary on finish", async () => {
    const [inserted] = await db
      .insert(opRuns)
      .values({ opSlug: "test-op", status: "running" })
      .returning();

    await db
      .update(opRuns)
      .set({
        status: "success",
        summary: "Processed 5 records",
        finishedAt: new Date(),
      })
      .where(eq(opRuns.id, inserted.id));

    const [updated] = await db
      .select()
      .from(opRuns)
      .where(eq(opRuns.id, inserted.id));

    expect(updated?.status).toBe("success");
    expect(updated?.summary).toBe("Processed 5 records");
    expect(updated?.finishedAt).toBeTruthy();
  });
});
