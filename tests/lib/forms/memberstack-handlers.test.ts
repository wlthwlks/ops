import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

const upsert = vi.fn(async () => ({
  record: { id: "rec1", fields: {} },
  created: true,
  shadowed: false,
  deferred: false,
}));
const findByMs = vi.fn(async () => []);
const updateProfile = vi.fn(async () => ({
  record: { id: "rec1", fields: {} },
  shadowed: false,
}));
const updateBilling = vi.fn(async () => ({ record: null, status: "updated" }));
const recordErr = vi.fn(async () => "e1");

vi.mock("@/lib/forms/airtable/members-sync", () => ({
  upsertMinimalSignupMember: (...a: unknown[]) => upsert(...a),
  findMemberByMemberstackId: (...a: unknown[]) => findByMs(...a),
  updateMemberProfile: (...a: unknown[]) => updateProfile(...a),
  updateMemberBilling: (...a: unknown[]) => updateBilling(...a),
}));

vi.mock("@/lib/forms/webhooks/store", () => ({
  recordIntegrationError: (...a: unknown[]) => recordErr(...a),
}));

describe("handleMemberstackEvent", () => {
  const prev = process.env.NEW_MEMBERSTACK_WEBHOOKS_ENABLED;
  const shadow = process.env.MAKE_SHADOW_MODE;

  beforeEach(() => {
    process.env.NEW_MEMBERSTACK_WEBHOOKS_ENABLED = "true";
    process.env.MAKE_SHADOW_MODE = "false";
    vi.clearAllMocks();
    vi.resetModules();
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.NEW_MEMBERSTACK_WEBHOOKS_ENABLED;
    else process.env.NEW_MEMBERSTACK_WEBHOOKS_ENABLED = prev;
    if (shadow === undefined) delete process.env.MAKE_SHADOW_MODE;
    else process.env.MAKE_SHADOW_MODE = shadow;
  });

  it("ignores when flag off", async () => {
    process.env.NEW_MEMBERSTACK_WEBHOOKS_ENABLED = "false";
    const { handleMemberstackEvent } = await import(
      "@/lib/forms/webhooks/memberstack-handlers"
    );
    const r = await handleMemberstackEvent({
      eventType: "member.created",
      payload: { data: { id: "m1", email: "a@b.com" } },
    });
    expect(r.status).toMatch(/ignored/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("member.created upserts minimal member from data envelope", async () => {
    const { handleMemberstackEvent } = await import(
      "@/lib/forms/webhooks/memberstack-handlers"
    );
    const r = await handleMemberstackEvent({
      eventType: "member.created",
      payload: {
        data: {
          id: "ms_1",
          email: "Ada@Ex.com",
          customFields: { "first-name": "Ada", "last-name": "L" },
        },
      },
    });
    expect(r.status).toBe("succeeded");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        memberstackId: "ms_1",
        email: "ada@ex.com",
      }),
      undefined,
      expect.objectContaining({ caller: "memberstack_webhook" })
    );
  });

  it("member.created parses Memberstack payload.payload envelope", async () => {
    const { handleMemberstackEvent, pickMember } = await import(
      "@/lib/forms/webhooks/memberstack-handlers"
    );
    const nested = pickMember({
      type: "member.created",
      payload: {
        id: "mem_nested",
        email: "Nested@Ex.com",
        customFields: { "first-name": "Ned", "last-name": "Nested" },
      },
    });
    expect(nested.id).toBe("mem_nested");
    expect(nested.email).toBe("nested@ex.com");
    expect(nested.firstName).toBe("Ned");

    const r = await handleMemberstackEvent({
      eventType: "member.created",
      payload: {
        type: "member.created",
        payload: {
          id: "mem_nested",
          email: "Nested@Ex.com",
          customFields: { "first-name": "Ned", "last-name": "Nested" },
        },
      },
    });
    expect(r.status).toBe("succeeded");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ memberstackId: "mem_nested", email: "nested@ex.com" }),
      undefined,
      expect.objectContaining({ caller: "memberstack_webhook" })
    );
  });

  it("pickMember supports nested member object under payload.payload", async () => {
    const { pickMember } = await import("@/lib/forms/webhooks/memberstack-handlers");
    const m = pickMember({
      payload: {
        member: {
          id: "mem_obj",
          auth: { email: "Auth@Ex.com" },
          customFields: { firstName: "Ann" },
        },
        stripeCustomerId: "cus_abc",
      },
    });
    expect(m.id).toBe("mem_obj");
    expect(m.email).toBe("auth@ex.com");
    expect(m.firstName).toBe("Ann");
    expect(m.stripeCustomerId).toBe("cus_abc");
  });

  it("member.updated records error when Airtable missing", async () => {
    findByMs.mockResolvedValueOnce([]);
    const { handleMemberstackEvent } = await import(
      "@/lib/forms/webhooks/memberstack-handlers"
    );
    const r = await handleMemberstackEvent({
      eventType: "member.updated",
      payload: { data: { id: "ms_missing", email: "x@y.com" } },
    });
    expect(r.status).toBe("failed");
    expect(recordErr).toHaveBeenCalled();
  });

  it("duplicate delivery path: no-op when no identity fields", async () => {
    findByMs.mockResolvedValueOnce([{ id: "rec1", fields: {} }]);
    const { handleMemberstackEvent } = await import(
      "@/lib/forms/webhooks/memberstack-handlers"
    );
    const r = await handleMemberstackEvent({
      eventType: "member.updated",
      payload: { data: { id: "ms_1" } },
    });
    expect(r.status).toBe("ignored");
    expect(r.reason).toMatch(/No-op/i);
  });

  it("plan.added reconciles plan/customer ids but never marks Paid/Active", async () => {
    findByMs.mockResolvedValueOnce([{ id: "rec1", fields: {} }]);
    const { handleMemberstackEvent } = await import(
      "@/lib/forms/webhooks/memberstack-handlers"
    );
    const r = await handleMemberstackEvent({
      eventType: "member.plan.added",
      payload: {
        data: {
          id: "mem_plan",
          planId: "prc_plan_x",
          stripeCustomerId: "cus_plan",
        },
      },
    });
    expect(r.status).toBe("succeeded");
    const patch = updateBilling.mock.calls[0][0].patch as Record<string, unknown>;
    expect(patch[MEMBER_FIELDS.memberstackPlanId]).toBe("prc_plan_x");
    expect(patch[MEMBER_FIELDS.stripeCustomerId]).toBe("cus_plan");
    expect(patch[MEMBER_FIELDS.payment]).toBeUndefined();
    expect(patch[MEMBER_FIELDS.membership]).toBeUndefined();
  });

  it("plan.added without plan id falls back to configured plan id, still no Paid/Active", async () => {
    const prevMsPrice = process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
    findByMs.mockResolvedValueOnce([{ id: "rec1", fields: {} }]);
    process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID = "prc_default_fallback";
    try {
      const { handleMemberstackEvent } = await import(
        "@/lib/forms/webhooks/memberstack-handlers"
      );
      const r = await handleMemberstackEvent({
        eventType: "member.plan.created",
        payload: {
          data: { id: "mem_plan2", stripeCustomerId: "cus_plan2" },
        },
      });
      expect(r.status).toBe("succeeded");
      const patch = updateBilling.mock.calls[0][0].patch as Record<string, unknown>;
      expect(patch[MEMBER_FIELDS.memberstackPlanId]).toBeTruthy();
      expect(patch[MEMBER_FIELDS.payment]).toBeUndefined();
      expect(patch[MEMBER_FIELDS.membership]).toBeUndefined();
    } finally {
      if (prevMsPrice === undefined) delete process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
      else process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID = prevMsPrice;
    }
  });
});
