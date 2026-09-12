import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const dbInsert = vi.fn(() => ({
  values: vi.fn(() => ({
    onConflictDoUpdate: vi.fn(async () => undefined),
  })),
}));

vi.mock("@/db", () => ({
  db: {
    insert: (...a: unknown[]) => dbInsert(...a),
  },
}));

const getMemberships = vi.fn();
const getConfig = vi.fn();

vi.mock("@/lib/integrations/sweatpals", () => ({
  getMemberMemberships: (...a: unknown[]) => getMemberships(...a),
  getSweatpalsApiConfig: (...a: unknown[]) => getConfig(...a),
  SweatpalsApiError: class SweatpalsApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

const findMemberByMs = vi.fn();
const updateRecords = vi.fn(async (_t: string, records: { id: string; fields: Record<string, unknown> }[]) => [
  { id: records[0]?.id ?? "rec1", fields: { ...(records[0]?.fields ?? {}) } },
]);

vi.mock("@/lib/forms/airtable/members-sync", () => ({
  findMemberByMemberstackId: (...a: unknown[]) => findMemberByMs(...a),
  getFormsAirtableClient: () => ({ updateRecords }),
}));

import { verifySweatpalsMembershipForMember } from "@/lib/forms/sweatpals/verify-membership";

const activeItem = {
  membershipName: "Monthly Unlimited",
  id: "3f1a9c20-1b2c-4d5e-8f90-a1b2c3d4e5f6",
  membershipId: "7a2b1c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
  membershipTierId: "5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
  active: true,
  paused: false,
  pauseFuturePayments: false,
  actualFrom: "2026-07-01T00:00:00.000Z",
  actualTo: "2026-08-01T00:00:00.000Z",
  expireDate: null,
  isClaimed: true,
};

const pausedItem = {
  ...activeItem,
  id: "8d9e0f1a-2b3c-4d5e-8f60-7a8b9c0d1e2f",
  active: false,
  pauseFuturePayments: true,
};

describe("verifySweatpalsMembershipForMember", () => {
  const prevKey = process.env.SWEATPALS_API_KEY;
  const prevShadow = process.env.MAKE_SHADOW_MODE;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env.SWEATPALS_API_KEY = "sp_test_key";
    process.env.SWEATPALS_COMMUNITY_ID = "5b2f388a-44c0-4587-b0de-e1be39e383dc";
    process.env.MAKE_SHADOW_MODE = "false";
    getConfig.mockReturnValue({
      apiBase: "https://ilove.staging.sweatpals.com",
      apiKey: "sp_test_key",
      communityId: "5b2f388a-44c0-4587-b0de-e1be39e383dc",
      apiKeyHeader: "x-api-key",
      timeoutMs: 5000,
    });
    findMemberByMs.mockResolvedValue([{ id: "rec1", fields: {} }]);
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.SWEATPALS_API_KEY;
    else process.env.SWEATPALS_API_KEY = prevKey;
    if (prevShadow === undefined) delete process.env.MAKE_SHADOW_MODE;
    else process.env.MAKE_SHADOW_MODE = prevShadow;
  });

  it("fails closed as not_configured when the API key is missing", async () => {
    getConfig.mockImplementation(() => {
      throw new Error("SWEATPALS_API_KEY is not set");
    });
    const res = await verifySweatpalsMembershipForMember({
      memberstackId: "m1",
      memberEmail: "a@b.com",
    });
    expect(res.status).toBe("not_configured");
    expect(res.membershipConfirmed).toBe(false);
    expect(getMemberships).not.toHaveBeenCalled();
  });

  it("reports unresolved when SweatPals does not know the member", async () => {
    getMemberships.mockResolvedValue(null);
    const res = await verifySweatpalsMembershipForMember({
      memberstackId: "m1",
      memberEmail: "a@b.com",
      lookupEmail: "typed@widget.com",
    });
    expect(res.status).toBe("unresolved");
    expect(res.membershipConfirmed).toBe(false);
    // widget email first, then member email, then phone
    expect(getMemberships.mock.calls[0][0]).toMatchObject({ email: "typed@widget.com" });
    expect(getMemberships.mock.calls[1][0]).toMatchObject({ email: "a@b.com" });
  });

  it("confirms an active membership, upserts rows and mirrors to Airtable", async () => {
    getMemberships.mockResolvedValue({
      list: [activeItem],
      limit: 25,
      offset: 0,
      total: 1,
    });
    const res = await verifySweatpalsMembershipForMember({
      memberstackId: "m1",
      memberEmail: "a@b.com",
      lookupEmail: "a@b.com",
    });
    expect(res.status).toBe("active");
    expect(res.membershipConfirmed).toBe(true);
    expect(res.sweeatpalsMemberId).toBe(activeItem.id);
    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(updateRecords).toHaveBeenCalledTimes(1);
    const [table, records] = updateRecords.mock.calls[0];
    expect(table).toBe("MEMBERS");
    const fields = records[0].fields as Record<string, unknown>;
    expect(fields["Membership"]).toBe("Active");
    expect(fields["Payment"]).toBe("Paid");
    expect(fields["Service access until"]).toBe("2026-08-01");
  });

  it("reports paused (not confirmed) and preserves access until actualTo", async () => {
    getMemberships.mockResolvedValue({
      list: [pausedItem],
      limit: 25,
      offset: 0,
      total: 1,
    });
    const res = await verifySweatpalsMembershipForMember({
      memberstackId: "m1",
      memberEmail: "a@b.com",
    });
    expect(res.status).toBe("paused");
    expect(res.membershipConfirmed).toBe(false);
    const [, records] = updateRecords.mock.calls[0];
    const fields = records[0].fields as Record<string, unknown>;
    expect(fields["Membership"]).toBe("Active");
    expect(fields["Service access until"]).toBe("2026-08-01");
  });

  it("shadows Airtable writes under MAKE_SHADOW_MODE", async () => {
    process.env.MAKE_SHADOW_MODE = "true";
    getMemberships.mockResolvedValue({
      list: [activeItem],
      limit: 25,
      offset: 0,
      total: 1,
    });
    const res = await verifySweatpalsMembershipForMember({
      memberstackId: "m1",
      memberEmail: "a@b.com",
    });
    expect(res.status).toBe("active");
    expect(res.shadowed).toBe(true);
    expect(updateRecords).not.toHaveBeenCalled();
    expect(dbInsert).toHaveBeenCalledTimes(1);
  });

  it("reports api_error when the SweatPals API throws", async () => {
    getMemberships.mockRejectedValue(new Error("boom"));
    const res = await verifySweatpalsMembershipForMember({
      memberstackId: "m1",
      memberEmail: "a@b.com",
    });
    expect(res.status).toBe("api_error");
    expect(res.membershipConfirmed).toBe(false);
  });
});
