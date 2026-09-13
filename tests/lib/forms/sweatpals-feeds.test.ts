import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getZapierFeed = vi.fn();

vi.mock("@/lib/integrations/sweatpals", () => ({
  getZapierFeed: (...a: unknown[]) => getZapierFeed(...a),
  SweatpalsApiError: class SweatpalsApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const reconcile = vi.fn();

vi.mock("@/lib/forms/sweatpals/verify-membership", () => ({
  reconcileSweatpalsMember: (...a: unknown[]) => reconcile(...a),
}));

let cursorRows: { cursor: string | null }[] = [];
const dbSelect = vi.fn(() => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({
      limit: vi.fn(async () => cursorRows),
    })),
  })),
}));
const dbInsert = vi.fn(() => ({
  values: vi.fn(() => ({
    onConflictDoUpdate: vi.fn(async () => undefined),
  })),
}));

vi.mock("@/db", () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
    insert: (...a: unknown[]) => dbInsert(...a),
  },
}));

import { syncSweatpalsFeed } from "@/lib/forms/sweatpals/feeds";

const row = (over: Record<string, unknown> = {}) => ({
  id: "row-1",
  user_email: "buyer@example.com",
  user_phone: "+15551112222",
  membership_name: "Founder Walk Member",
  createdAt: "2026-09-13T10:00:00.000Z",
  ...over,
});

describe("syncSweatpalsFeed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cursorRows = [];
    getZapierFeed.mockResolvedValue([]);
    reconcile.mockResolvedValue({
      success: true,
      status: "active",
      membershipConfirmed: true,
      active: true,
      paused: false,
      count: 1,
      shadowed: false,
      mirrorStatus: "updated",
      mirrorRecordId: "rec1",
      changedCount: 1,
      accessUntil: "2099-08-01",
      membershipName: "Founder Walk Member",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("processes fresh rows and advances the cursor", async () => {
    getZapierFeed.mockResolvedValue([row()]);
    const res = await syncSweatpalsFeed("new-members", { apply: true });
    expect(res.scanned).toBe(1);
    expect(res.processed).toBe(1);
    expect(res.synced).toBe(1);
    expect(res.cursorAdvancedTo).toBe("2026-09-13T10:00:00.000Z");
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        emails: ["buyer@example.com"],
        phone: "+15551112222",
        dryRun: false,
      })
    );
    expect(dbInsert).toHaveBeenCalled();
  });

  it("skips rows at or before the stored cursor", async () => {
    cursorRows = [{ cursor: "2026-09-13T10:00:00.000Z" }];
    getZapierFeed.mockResolvedValue([
      row({ createdAt: "2026-09-13T10:00:00.000Z" }),
      row({ id: "row-2", createdAt: "2026-09-12T09:00:00.000Z" }),
    ]);
    const res = await syncSweatpalsFeed("new-members", { apply: true });
    expect(res.processed).toBe(0);
    expect(reconcile).not.toHaveBeenCalled();
    expect(res.cursorAdvancedTo).toBeNull();
  });

  it("skips rows without identity", async () => {
    getZapierFeed.mockResolvedValue([row({ user_email: undefined, user_phone: undefined })]);
    const res = await syncSweatpalsFeed("new-members", { apply: true });
    expect(res.skippedNoIdentity).toBe(1);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("dry-run reconciles without applying Airtable mirror or consuming the cursor", async () => {
    getZapierFeed.mockResolvedValue([row()]);
    const res = await syncSweatpalsFeed("new-members", { apply: false });
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    expect(res.nextCursor).toBe("2026-09-13T10:00:00.000Z");
    expect(res.cursorAdvancedTo).toBeNull();
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it("counts failures and reports feed errors", async () => {
    reconcile.mockResolvedValue({ status: "api_error", success: false });
    getZapierFeed.mockResolvedValue([row()]);
    const res = await syncSweatpalsFeed("new-members", { apply: true });
    expect(res.failed).toBe(1);

    getZapierFeed.mockRejectedValue(new Error("boom"));
    const res2 = await syncSweatpalsFeed("cancelled-members");
    expect(res2.error).toContain("boom");
  });
});
