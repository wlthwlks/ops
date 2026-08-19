import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const findMember = vi.fn(async () => []);
const verifyToken = vi.fn(async () => ({
  id: "mem_1",
  email: "a@b.com",
  raw: {},
}));

vi.mock("@/lib/forms/memberstack/auth", () => ({
  extractMemberstackToken: () => "tok_test",
  verifyMemberstackToken: (...a: unknown[]) => verifyToken(...a),
}));

vi.mock("@/lib/forms/http", () => ({
  enforcePublicWriteRateLimit: () => null,
}));

vi.mock("@/lib/forms/airtable/members-sync", () => ({
  findMemberByMemberstackId: (...a: unknown[]) => findMember(...a),
}));

const CATALOG_JSON = JSON.stringify({
  version: 1,
  defaultTierKey: "standard",
  defaultPriceKey: "standard_quarterly_default",
  prices: [
    {
      priceKey: "standard_quarterly_default",
      tierKey: "standard",
      cadence: "quarterly",
      stripePriceId: "price_default_87",
      memberstackPriceId: "prc_default_87",
      sellable: true,
      legacy: false,
      eligibleForSignup: true,
      eligibleForReactivation: true,
      label: "$87 every 3 months",
    },
    {
      priceKey: "standard_quarterly_founders45",
      tierKey: "standard",
      cadence: "quarterly",
      stripePriceId: "price_founders45",
      memberstackPriceId: "prc_founders45",
      sellable: true,
      legacy: false,
      eligibleForSignup: true,
      eligibleForReactivation: false,
      label: "$45 every 3 months",
      description: "3 months free, then $45 every 3 months indefinitely",
      trialDays: 90,
    },
    {
      priceKey: "offer_without_prc",
      tierKey: "standard",
      cadence: "quarterly",
      stripePriceId: "price_no_prc",
      sellable: true,
      legacy: false,
      eligibleForSignup: true,
      eligibleForReactivation: false,
    },
  ],
  offers: [
    {
      offerKey: "founders45",
      code: "FOUNDERS45",
      targetPriceKey: "standard_quarterly_founders45",
      enabled: true,
      newCustomersOnly: true,
      startDate: null,
      endDate: null,
      redemptionLimits: null,
    },
    {
      offerKey: "disabled_offer",
      code: "DISABLED45",
      targetPriceKey: "standard_quarterly_default",
      enabled: false,
    },
    {
      offerKey: "no_prc_offer",
      code: "NOPRC",
      targetPriceKey: "offer_without_prc",
      enabled: true,
    },
  ],
});

import { POST } from "@/app/api/onboarding/billing-offer/route";
import { FormsError } from "@/lib/forms/errors";

const SAVED_ENV: Record<string, string | undefined> = {};

function saveEnv() {
  for (const k of [
    "BILLING_CATALOG_JSON",
    "STRIPE_MEMBERSHIP_PRICE_IDS",
    "STRIPE_REACTIVATION_PRICE_ID",
    "MEMBERSTACK_MEMBERSHIP_PRICE_ID",
    "MEMBERSTACK_PLAN_ID",
  ]) {
    SAVED_ENV[k] = process.env[k];
  }
}

function restoreEnv() {
  for (const [k, v] of Object.entries(SAVED_ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/onboarding/billing-offer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/onboarding/billing-offer", () => {
  beforeEach(() => {
    saveEnv();
    process.env.BILLING_CATALOG_JSON = CATALOG_JSON;
    delete process.env.STRIPE_MEMBERSHIP_PRICE_IDS;
    delete process.env.STRIPE_REACTIVATION_PRICE_ID;
    delete process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
    delete process.env.MEMBERSTACK_PLAN_ID;
    vi.clearAllMocks();
    findMember.mockResolvedValue([
      {
        id: "rec1",
        fields: { Payment: "", Membership: "", "Onboarding status": "PAYMENT_PENDING" },
      },
    ]);
  });

  afterEach(() => {
    restoreEnv();
  });

  it("resolves valid FOUNDERS45 (case-insensitive) to the special Memberstack price", async () => {
    const res = await POST(makeRequest({ code: " founders45 " }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(true);
    expect(body.offerCode).toBe("FOUNDERS45");
    expect(body.priceKey).toBe("standard_quarterly_founders45");
    expect(body.memberstackPriceId).toBe("prc_founders45");
    expect(body.description).toContain("3 months free, then $45");
  });

  it("rejects invalid code with a clear error and no price fallback", async () => {
    const res = await POST(makeRequest({ code: "WRONG99" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.code).toBe("INVALID_OFFER_CODE");
    expect(body.message).toMatch(/invalid or has expired/i);
    expect(body.memberstackPriceId).toBeUndefined();
  });

  it("rejects disabled code with no price fallback", async () => {
    const res = await POST(makeRequest({ code: "DISABLED45" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.status).toBe("disabled");
    expect(body.memberstackPriceId).toBeUndefined();
  });

  it("rejects missing code", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("MISSING_OFFER_CODE");
  });

  it("never trusts client-supplied Stripe/Memberstack price ids", async () => {
    const res = await POST(makeRequest({ code: "price_hacked" }));
    expect(res.status).toBe(400);
    const res2 = await POST(makeRequest({ code: "prc_hacked" }));
    expect(res2.status).toBe(400);
  });

  it("rejects new-customers-only code for an existing paid member", async () => {
    findMember.mockResolvedValue([
      {
        id: "rec1",
        fields: {
          Payment: "Paid",
          Membership: "Active",
          "Onboarding status": "COMPLETE",
        },
      },
    ]);
    const res = await POST(makeRequest({ code: "FOUNDERS45" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe("new_customers_only");
  });

  it("returns unavailable when the target price has no Memberstack id", async () => {
    const res = await POST(makeRequest({ code: "NOPRC" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.status).toBe("unavailable");
  });

  it("returns 401 when Memberstack auth fails", async () => {
    verifyToken.mockImplementationOnce(() => {
      throw new FormsError("AUTH_FAILED", "Unauthorized", { status: 401 });
    });
    const res = await POST(makeRequest({ code: "FOUNDERS45" }));
    expect(res.status).toBe(401);
  });
});
