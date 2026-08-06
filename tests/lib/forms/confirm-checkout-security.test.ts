import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  verifyCheckoutSessionOwnership,
  isCheckoutSessionPaid,
  filterNativeQualifyingPrices,
  extractSessionLinePriceIds,
  sessionCustomerId,
  passesPriceGate,
  allowsMemberstackCommercePreviewQualification,
  extractStripeCustomerIdFromMemberstackRaw,
} from "@/lib/forms/billing/confirm-checkout";
import type Stripe from "stripe";

function session(partial: Record<string, unknown>): Stripe.Checkout.Session {
  return partial as unknown as Stripe.Checkout.Session;
}

describe("confirm-checkout ownership & payment gates", () => {
  it("accepts client_reference_id match", () => {
    const r = verifyCheckoutSessionOwnership({
      memberstackId: "mem_1",
      session: session({
        client_reference_id: "mem_1",
        customer: "cus_abc",
        metadata: {},
      }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe("client_reference_id");
  });

  it("hard-rejects session owned by another member via client_reference_id", () => {
    const r = verifyCheckoutSessionOwnership({
      memberstackId: "mem_1",
      session: session({
        client_reference_id: "mem_other",
        customer: "cus_abc",
        metadata: {},
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.hard).toBe(true);
      expect(r.status).toBe("session_ownership_mismatch");
    }
  });

  it("accepts metadata.memberstackId match", () => {
    const r = verifyCheckoutSessionOwnership({
      memberstackId: "mem_1",
      session: session({
        client_reference_id: null,
        customer: "cus_abc",
        metadata: { memberstackId: "mem_1" },
      }),
    });
    expect(r.ok).toBe(true);
  });

  it("accepts matching existing Airtable Stripe customer", () => {
    const r = verifyCheckoutSessionOwnership({
      memberstackId: "mem_1",
      session: session({
        client_reference_id: null,
        customer: "cus_stored",
        metadata: {},
      }),
      existingAirtableStripeCustomerId: "cus_stored",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe("airtable_stripe_customer_id");
  });

  it("hard-rejects Airtable customer conflict", () => {
    const r = verifyCheckoutSessionOwnership({
      memberstackId: "mem_1",
      session: session({
        client_reference_id: null,
        customer: "cus_session",
        metadata: {},
      }),
      existingAirtableStripeCustomerId: "cus_other",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.hard).toBe(true);
      expect(r.status).toBe("stripe_customer_conflict");
    }
  });

  it("soft-unproven when no ownership ids (fall through allowed)", () => {
    const r = verifyCheckoutSessionOwnership({
      memberstackId: "mem_1",
      session: session({
        client_reference_id: null,
        customer: "cus_x",
        metadata: {},
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.hard).toBe(false);
      expect(r.status).toBe("session_ownership_unproven");
    }
  });

  it("requires payment_status paid (complete alone is not enough)", () => {
    expect(
      isCheckoutSessionPaid(
        session({ payment_status: "unpaid", status: "complete" })
      )
    ).toBe(false);
    expect(
      isCheckoutSessionPaid(session({ payment_status: "paid", status: "complete" }))
    ).toBe(true);
  });

  it("filters only approved native membership prices", () => {
    const allow = new Set(["price_membership"]);
    expect(
      filterNativeQualifyingPrices(
        ["price_membership", "price_other", "prc_ms"],
        allow
      )
    ).toEqual(["price_membership"]);
    expect(filterNativeQualifyingPrices(["price_other"], allow)).toEqual([]);
    expect(filterNativeQualifyingPrices(["price_membership"], new Set())).toEqual([]);
  });

  it("extracts line price ids from session", () => {
    const ids = extractSessionLinePriceIds(
      session({
        line_items: {
          data: [
            { price: { id: "price_a" } },
            { price: { id: "price_b" } },
            { price: { id: "prc_skip" } },
          ],
        },
      })
    );
    expect(ids).toEqual(["price_a", "price_b"]);
  });

  it("reads session customer id", () => {
    expect(sessionCustomerId(session({ customer: "cus_1" }))).toBe("cus_1");
    expect(sessionCustomerId(session({ customer: { id: "cus_2" } }))).toBe("cus_2");
  });

  it("digs stripe customer from nested Memberstack raw", () => {
    expect(
      extractStripeCustomerIdFromMemberstackRaw({
        billing: { stripeCustomerId: "cus_nested" },
      })
    ).toBe("cus_nested");
  });
});

describe("passesPriceGate dual-env", () => {
  it("native allowlist requires match", () => {
    const r = passesPriceGate({
      priceIds: ["price_other"],
      nativeAllow: new Set(["price_membership"]),
      previewCommerceMode: false,
    });
    expect(r.ok).toBe(false);

    const ok = passesPriceGate({
      priceIds: ["price_membership", "price_other"],
      nativeAllow: new Set(["price_membership"]),
      previewCommerceMode: false,
    });
    expect(ok.ok).toBe(true);
    expect(ok.qualifying).toEqual(["price_membership"]);
    expect(ok.mode).toBe("native_allowlist");
  });

  it("preview commerce mode accepts any price_ when owned payment proven", () => {
    const r = passesPriceGate({
      priceIds: ["price_whatever_ms_mapped"],
      nativeAllow: new Set(),
      previewCommerceMode: true,
    });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("memberstack_commerce_preview");
  });

  it("preview commerce mode rejects empty prices", () => {
    const r = passesPriceGate({
      priceIds: [],
      nativeAllow: new Set(),
      previewCommerceMode: true,
    });
    expect(r.ok).toBe(false);
  });

  it("fail closed when no native and not preview commerce", () => {
    const r = passesPriceGate({
      priceIds: ["price_x"],
      nativeAllow: new Set(),
      previewCommerceMode: false,
    });
    expect(r.ok).toBe(false);
    expect(r.mode).toBe("fail_closed");
  });
});

describe("allowsMemberstackCommercePreviewQualification", () => {
  const prevStripe = process.env.STRIPE_MEMBERSHIP_PRICE_IDS;
  const prevMs = process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
  const prevVercel = process.env.VERCEL_ENV;

  beforeEach(() => {
    delete process.env.VERCEL_ENV;
    delete process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
  });

  afterEach(() => {
    if (prevStripe === undefined) delete process.env.STRIPE_MEMBERSHIP_PRICE_IDS;
    else process.env.STRIPE_MEMBERSHIP_PRICE_IDS = prevStripe;
    if (prevMs === undefined) delete process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID;
    else process.env.MEMBERSTACK_MEMBERSHIP_PRICE_ID = prevMs;
    if (prevVercel === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = prevVercel;
  });

  it("true for prc-only on Vercel preview (even if NODE_ENV=production)", () => {
    process.env.STRIPE_MEMBERSHIP_PRICE_IDS = "prc_wlth_test";
    process.env.VERCEL_ENV = "preview";
    expect(allowsMemberstackCommercePreviewQualification()).toBe(true);
  });

  it("false when native price configured", () => {
    process.env.STRIPE_MEMBERSHIP_PRICE_IDS = "price_real";
    process.env.VERCEL_ENV = "preview";
    expect(allowsMemberstackCommercePreviewQualification()).toBe(false);
  });

  it("false on vercel production even with prc-only", () => {
    process.env.STRIPE_MEMBERSHIP_PRICE_IDS = "prc_wlth_test";
    process.env.VERCEL_ENV = "production";
    expect(allowsMemberstackCommercePreviewQualification()).toBe(false);
  });
});
