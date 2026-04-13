import { describe, it, expect } from "vitest";
import type { Op, OpContext, OpResult } from "@/lib/types";

describe("Op type", () => {
  it("accepts a valid op definition", () => {
    const op: Op = {
      slug: "test-op",
      name: "Test Op",
      description: "A test operation",
      schedule: "0 * * * *",
      run: async (ctx: OpContext): Promise<OpResult> => {
        ctx.log("running");
        return { success: true, summary: "done", recordsProcessed: 0 };
      },
    };
    expect(op.slug).toBe("test-op");
    expect(op.schedule).toBe("0 * * * *");
  });

  it("allows op without schedule", () => {
    const op: Op = {
      slug: "manual-op",
      name: "Manual Op",
      description: "Manual only",
      run: async () => ({ success: true, summary: "done" }),
    };
    expect(op.schedule).toBeUndefined();
  });
});
