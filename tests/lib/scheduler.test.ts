import { describe, it, expect, vi, beforeEach } from "vitest";
import { createScheduler } from "@/lib/scheduler";
import type { Op } from "@/lib/types";

vi.mock("node-cron", () => ({
  default: {
    schedule: vi.fn(() => ({ stop: vi.fn() })),
    validate: vi.fn((expr: string) => expr.split(" ").length === 5),
  },
}));

describe("Scheduler", () => {
  const mockRunOp = vi.fn().mockResolvedValue({ success: true, summary: "ok" });

  const scheduledOp: Op = {
    slug: "hourly-sync",
    name: "Hourly Sync",
    description: "Syncs every hour",
    schedule: "0 * * * *",
    run: async () => ({ success: true, summary: "done" }),
  };

  const manualOp: Op = {
    slug: "manual-op",
    name: "Manual Op",
    description: "No schedule",
    run: async () => ({ success: true, summary: "done" }),
  };

  beforeEach(() => { vi.clearAllMocks(); });

  it("registers cron jobs for scheduled ops", async () => {
    const cron = await import("node-cron");
    const scheduler = createScheduler([scheduledOp, manualOp], mockRunOp);
    scheduler.start();
    expect(cron.default.schedule).toHaveBeenCalledTimes(1);
    expect(cron.default.schedule).toHaveBeenCalledWith("0 * * * *", expect.any(Function));
  });

  it("stops all cron jobs", async () => {
    const stopFn = vi.fn();
    const cron = await import("node-cron");
    (cron.default.schedule as any).mockReturnValue({ stop: stopFn });

    const scheduler = createScheduler([scheduledOp], mockRunOp);
    scheduler.start();
    scheduler.stop();
    expect(stopFn).toHaveBeenCalledTimes(1);
  });
});
