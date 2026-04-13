import { describe, it, expect } from "vitest";
import { createRegistry } from "@/lib/registry";
import type { Op } from "@/lib/types";

const fakeOp: Op = {
  slug: "fake-op",
  name: "Fake Op",
  description: "A fake op for testing",
  run: async () => ({ success: true, summary: "done" }),
};

const scheduledOp: Op = {
  slug: "scheduled-op",
  name: "Scheduled Op",
  description: "Runs on a schedule",
  schedule: "*/15 * * * *",
  run: async () => ({ success: true, summary: "done" }),
};

describe("registry", () => {
  it("registers and retrieves ops", () => {
    const registry = createRegistry([fakeOp, scheduledOp]);
    expect(registry.getAll()).toHaveLength(2);
    expect(registry.getBySlug("fake-op")).toBe(fakeOp);
    expect(registry.getBySlug("nonexistent")).toBeUndefined();
  });

  it("returns only scheduled ops", () => {
    const registry = createRegistry([fakeOp, scheduledOp]);
    const scheduled = registry.getScheduled();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].slug).toBe("scheduled-op");
  });
});
