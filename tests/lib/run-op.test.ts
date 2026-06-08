import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runOp } from "@/lib/run-op";
import { opRuns } from "@/db/schema";
import type { Op } from "@/lib/types";
import { createTestDb, type TestDb } from "../helpers/test-db";

describe("runOp", () => {
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

  it("runs a successful op and records history", async () => {
    const op: Op = {
      slug: "test-op",
      name: "Test",
      description: "test",
      run: async (ctx) => {
        await ctx.log("working");
        return { success: true, summary: "done", recordsProcessed: 3 };
      },
    };

    const result = await runOp(op, db);
    expect(result.success).toBe(true);
    expect(result.summary).toBe("done");

    const runs = await db.select().from(opRuns);
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

    const runs = await db.select().from(opRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
  });
});
