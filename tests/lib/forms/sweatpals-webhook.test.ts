import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const reconcile = vi.fn();

vi.mock("@/lib/forms/sweatpals/verify-membership", () => ({
  reconcileSweatpalsMember: (...a: unknown[]) => reconcile(...a),
}));

const dbSelect = vi.fn(() => ({
  from: vi.fn(() => ({
    where: vi.fn(() => ({
      limit: vi.fn(async () => dbRows),
    })),
  })),
}));
let dbRows: unknown[] = [];

vi.mock("@/db", () => ({
  db: {
    select: (...a: unknown[]) => dbSelect(...a),
  },
}));

import {
  handleSweatpalsEvent,
  normalizeSweatpalsEventType,
  pickSweatpalsIdentity,
  unwrapSweatpalsEnvelope,
} from "@/lib/forms/sweatpals/webhook-handler";

const succeeded = {
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
  accessUntil: "2026-08-01",
  membershipName: "Founder Walk Member",
};

describe("sweatpals webhook parsing", () => {
  it("normalizes event types", () => {
    expect(normalizeSweatpalsEventType("Membership_Updated")).toBe("membership.updated");
    expect(normalizeSweatpalsEventType("membership.created")).toBe("membership.created");
  });

  it("flattens nested envelopes", () => {
    const payload = { type: "membership.created", data: { email: "a@b.com" } };
    expect(unwrapSweatpalsEnvelope(payload)).toEqual({ email: "a@b.com" });
  });

  it("extracts identity from nested member", () => {
    const id = pickSweatpalsIdentity({
      type: "membership.updated",
      communityId: "comm1",
      userToMembershipId: "utm1",
      member: { email: "Buyer@Example.com", phone: "+15551234567" },
      membership: { membershipTierId: "tier1" },
    });
    expect(id.email).toBe("buyer@example.com");
    expect(id.phone).toBe("+15551234567");
    expect(id.userToMembershipId).toBe("utm1");
    expect(id.membershipTierId).toBe("tier1");
    expect(id.communityId).toBe("comm1");
  });
});

describe("handleSweatpalsEvent", () => {
  const prevEnabled = process.env.SWEATPALS_WEBHOOKS_ENABLED;
  const prevShadow = process.env.MAKE_SHADOW_MODE;

  beforeEach(() => {
    process.env.SWEATPALS_WEBHOOKS_ENABLED = "true";
    process.env.MAKE_SHADOW_MODE = "false";
    vi.clearAllMocks();
    dbRows = [];
    reconcile.mockResolvedValue(succeeded);
  });

  afterEach(() => {
    if (prevEnabled === undefined) delete process.env.SWEATPALS_WEBHOOKS_ENABLED;
    else process.env.SWEATPALS_WEBHOOKS_ENABLED = prevEnabled;
    if (prevShadow === undefined) delete process.env.MAKE_SHADOW_MODE;
    else process.env.MAKE_SHADOW_MODE = prevShadow;
  });

  it("ignores when the webhook flag is off", async () => {
    process.env.SWEATPALS_WEBHOOKS_ENABLED = "false";
    const res = await handleSweatpalsEvent({
      eventType: "membership.created",
      payload: { email: "a@b.com" },
    });
    expect(res.status).toBe("ignored_flag_off");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("ignores non-membership events", async () => {
    const res = await handleSweatpalsEvent({
      eventType: "event.published",
      payload: { email: "a@b.com" },
    });
    expect(res.status).toBe("ignored_irrelevant");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("ignores payloads without identity", async () => {
    const res = await handleSweatpalsEvent({
      eventType: "membership.updated",
      payload: { foo: "bar" },
    });
    expect(res.status).toBe("ignored_no_identity");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("reconciles by email and mirrors billing state", async () => {
    const res = await handleSweatpalsEvent({
      eventType: "membership.created",
      payload: { email: "buyer@example.com" },
    });
    expect(res.status).toBe("succeeded");
    expect(res.processed).toBe(true);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0][0]).toMatchObject({
      emails: ["buyer@example.com"],
      mirrorEmail: "buyer@example.com",
      dryRun: false,
    });
  });

  it("resolves stored linkage from userToMembershipId", async () => {
    dbRows = [
      {
        memberId: "m1",
        sweatpalsEmail: "stored@example.com",
        sweatpalsPhone: "+15551112222",
      },
    ];
    const res = await handleSweatpalsEvent({
      eventType: "membership.cancelled",
      payload: { userToMembershipId: "utm123" },
    });
    expect(res.status).toBe("succeeded");
    const call = reconcile.mock.calls[0][0];
    expect(call.memberstackId).toBe("m1");
    expect(call.emails).toContain("stored@example.com");
    expect(call.phone).toBe("+15551112222");
  });

  it("fails when the SweatPals sync errors", async () => {
    reconcile.mockResolvedValue({ ...succeeded, status: "api_error", reason: "boom" });
    const res = await handleSweatpalsEvent({
      eventType: "payment.failed",
      payload: { email: "buyer@example.com" },
    });
    expect(res.status).toBe("failed");
    expect(res.reason).toBe("boom");
  });
});
