import { describe, it, expect } from "vitest";
import {
  verifyCheckoutSessionOwnership,
  isCheckoutSessionPaid,
  filterNativeQualifyingPrices,
  extractSessionLinePriceIds,
  sessionCustomerId,
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

  it("rejects session owned by another member via client_reference_id", () => {
    const r = verifyCheckoutSessionOwnership({
      memberstackId: "mem_1",
      session: session({
        client_reference_id: "mem_other",
        customer: "cus_abc",
        metadata: {},
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("session_ownership_mismatch");
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

  it("rejects Airtable customer conflict", () => {
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
    if (!r.ok) expect(r.status).toBe("stripe_customer_conflict");
  });

  it("rejects when ownership cannot be proven", () => {
    const r = verifyCheckoutSessionOwnership({
      memberstackId: "mem_1",
      session: session({
        client_reference_id: null,
        customer: "cus_x",
        metadata: {},
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("session_ownership_unproven");
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
});
