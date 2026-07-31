import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import {
  getMemberRegistrationRetryHours,
  isWithinMemberRegistrationRetryWindow,
  extractStripeCustomerEmail,
  syncInvoicePaidToAirtable,
  DEFAULT_MEMBER_REGISTRATION_RETRY_HOURS,
} from "@/lib/billing/webhook-invoice-sync";
import { SERVICE_ACCESS_FIELD, STRIPE_CUSTOMER_ID_FIELD } from "@/lib/billing/service-access-sync";

function mockAirtable(handlers: {
  byCustomerId?: AirtableRecord[];
  byEmail?: AirtableRecord[];
}) {
  const updateRecordsBatched = vi.fn(async (_t: string, updates: Array<{ id: string }>) =>
    updates.map((u) => ({ id: u.id, fields: {} }))
  );
  const listRecords = vi.fn(async (_table: string, opts?: { filterByFormula?: string }) => {
    const f = opts?.filterByFormula || "";
    if (f.includes("Stripe Customer ID")) {
      return handlers.byCustomerId ?? [];
    }
    if (f.includes("email") || f.includes("LOWER")) {
      return handlers.byEmail ?? [];
    }
    return [];
  });
  return {
    listRecords,
    updateRecordsBatched,
    getRecord: vi.fn(),
    createRecords: vi.fn(),
    createRecordsBatched: vi.fn(),
    updateRecords: vi.fn(),
  } as unknown as AirtableClient & {
    listRecords: ReturnType<typeof vi.fn>;
    updateRecordsBatched: ReturnType<typeof vi.fn>;
    createRecords: ReturnType<typeof vi.fn>;
  };
}

function mockStripe(customer: { id: string; email?: string | null; deleted?: boolean }) {
  const clients = {
    customers: {
      retrieve: vi.fn(async () => customer),
    },
  };
  return clients;
}

describe("getMemberRegistrationRetryHours", () => {
  const prev = process.env.STRIPE_MEMBER_REGISTRATION_RETRY_HOURS;
  afterEach(() => {
    if (prev === undefined) delete process.env.STRIPE_MEMBER_REGISTRATION_RETRY_HOURS;
    else process.env.STRIPE_MEMBER_REGISTRATION_RETRY_HOURS = prev;
  });

  it("defaults to 24", () => {
    delete process.env.STRIPE_MEMBER_REGISTRATION_RETRY_HOURS;
    expect(getMemberRegistrationRetryHours()).toBe(DEFAULT_MEMBER_REGISTRATION_RETRY_HOURS);
  });

  it("reads env", () => {
    process.env.STRIPE_MEMBER_REGISTRATION_RETRY_HOURS = "12";
    expect(getMemberRegistrationRetryHours()).toBe(12);
  });
});

describe("isWithinMemberRegistrationRetryWindow", () => {
  it("true inside window", () => {
    const paidAt = Math.floor(Date.now() / 1000) - 3600; // 1h ago
    expect(
      isWithinMemberRegistrationRetryWindow({
        paidAtUnix: paidAt,
        retryHours: 24,
      })
    ).toBe(true);
  });

  it("false outside window", () => {
    const paidAt = Math.floor(Date.now() / 1000) - 48 * 3600;
    expect(
      isWithinMemberRegistrationRetryWindow({
        paidAtUnix: paidAt,
        retryHours: 24,
      })
    ).toBe(false);
  });

  it("uses created when paid_at missing", () => {
    const created = Math.floor(Date.now() / 1000) - 3600;
    expect(
      isWithinMemberRegistrationRetryWindow({
        paidAtUnix: null,
        createdUnix: created,
        retryHours: 24,
      })
    ).toBe(true);
  });

  it("false when retryHours is 0", () => {
    expect(
      isWithinMemberRegistrationRetryWindow({
        paidAtUnix: Math.floor(Date.now() / 1000),
        retryHours: 0,
      })
    ).toBe(false);
  });
});

describe("extractStripeCustomerEmail", () => {
  it("reads email", () => {
    expect(
      extractStripeCustomerEmail({
        id: "cus_1",
        object: "customer",
        email: "  A@B.com ",
      } as never)
    ).toBe("A@B.com");
  });

  it("null for deleted", () => {
    expect(
      extractStripeCustomerEmail({ id: "cus_1", object: "customer", deleted: true } as never)
    ).toBe(null);
  });
});

describe("syncInvoicePaidToAirtable", () => {
  const paidThrough = new Date("2026-09-01T00:00:00.000Z");
  const paidAt = Math.floor(Date.now() / 1000) - 60;

  beforeEach(() => {
    delete process.env.STRIPE_MEMBER_REGISTRATION_RETRY_HOURS;
  });

  it("updates when matched by Stripe Customer ID", async () => {
    const airtable = mockAirtable({
      byCustomerId: [{ id: "rec1", fields: { [STRIPE_CUSTOMER_ID_FIELD]: "cus_1" } }],
    });
    const stripe = mockStripe({ id: "cus_1", email: "a@b.com" });

    const r = await syncInvoicePaidToAirtable({
      airtable,
      stripe,
      stripeCustomerId: "cus_1",
      paidThrough,
      stripeInvoiceId: "in_1",
      invoicePaidAtUnix: paidAt,
    });

    expect(r.status).toBe("updated");
    expect(r.shouldRetry).toBe(false);
    expect(r.linkedStripeCustomerId).toBe(false);
    expect(airtable.updateRecordsBatched).toHaveBeenCalled();
    expect(airtable.createRecords).not.toHaveBeenCalled();
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
  });

  it("does not email-match or link blank Stripe Customer ID", async () => {
    const airtable = mockAirtable({
      byCustomerId: [],
      byEmail: [{ id: "rec_e", fields: { email: "a@b.com" } }],
    });
    const stripe = mockStripe({ id: "cus_1", email: "a@b.com" });
    const r = await syncInvoicePaidToAirtable({
      airtable,
      stripe,
      stripeCustomerId: "cus_1",
      paidThrough,
      stripeInvoiceId: "in_1",
      invoicePaidAtUnix: paidAt,
    });

    expect(r.linkedStripeCustomerId).toBe(false);
    expect(r.status).toBe("member_registration_pending");
    expect(r.shouldRetry).toBe(true);
    expect(airtable.updateRecordsBatched).not.toHaveBeenCalled();
    expect(airtable.createRecords).not.toHaveBeenCalled();
    // Must not query by email on webhook path
    const formulas = airtable.listRecords.mock.calls.map(
      (c) => (c[1] as { filterByFormula?: string } | undefined)?.filterByFormula || ""
    );
    expect(formulas.every((f) => !f.includes("LOWER") && !f.includes("email"))).toBe(
      true
    );
    expect(stripe.customers.retrieve).not.toHaveBeenCalled();
  });

  it("returns 503-intent (shouldRetry) when member missing inside window", async () => {
    const airtable = mockAirtable({ byCustomerId: [], byEmail: [] });
    const stripe = mockStripe({ id: "cus_1", email: "new@b.com" });
    const r = await syncInvoicePaidToAirtable({
      airtable,
      stripe,
      stripeCustomerId: "cus_1",
      paidThrough,
      stripeInvoiceId: "in_1",
      invoicePaidAtUnix: Math.floor(Date.now() / 1000) - 60,
    });
    expect(r.status).toBe("member_registration_pending");
    expect(r.shouldRetry).toBe(true);
    expect(airtable.createRecords).not.toHaveBeenCalled();
    expect(airtable.updateRecordsBatched).not.toHaveBeenCalled();
  });

  it("returns stripe_member_not_found after retry window expires", async () => {
    const airtable = mockAirtable({ byCustomerId: [], byEmail: [] });
    const stripe = mockStripe({ id: "cus_1", email: "new@b.com" });
    const r = await syncInvoicePaidToAirtable({
      airtable,
      stripe,
      stripeCustomerId: "cus_1",
      paidThrough,
      stripeInvoiceId: "in_1",
      invoicePaidAtUnix: Math.floor(Date.now() / 1000) - 48 * 3600,
    });
    expect(r.status).toBe("stripe_member_not_found");
    expect(r.shouldRetry).toBe(false);
    expect(airtable.createRecords).not.toHaveBeenCalled();
    expect(airtable.updateRecordsBatched).not.toHaveBeenCalled();
  });

  it("never creates members", async () => {
    const airtable = mockAirtable({ byCustomerId: [], byEmail: [] });
    const stripe = mockStripe({ id: "cus_1", email: "x@y.com" });
    await syncInvoicePaidToAirtable({
      airtable,
      stripe,
      stripeCustomerId: "cus_1",
      paidThrough,
      stripeInvoiceId: "in_1",
      invoicePaidAtUnix: paidAt,
    });
    expect(airtable.createRecords).not.toHaveBeenCalled();
    expect(airtable.createRecordsBatched).not.toHaveBeenCalled();
  });

  it("preserves later existing access when updating after link", async () => {
    const airtable = mockAirtable({
      byCustomerId: [
        {
          id: "rec1",
          fields: {
            [STRIPE_CUSTOMER_ID_FIELD]: "cus_1",
            [SERVICE_ACCESS_FIELD]: "2026-12-01T00:00:00.000Z",
          },
        },
      ],
    });
    const stripe = mockStripe({ id: "cus_1", email: "a@b.com" });
    const r = await syncInvoicePaidToAirtable({
      airtable,
      stripe,
      stripeCustomerId: "cus_1",
      paidThrough,
      stripeInvoiceId: "in_1",
      invoicePaidAtUnix: paidAt,
    });
    expect(r.status).toBe("existing_later");
    expect(airtable.updateRecordsBatched).not.toHaveBeenCalled();
  });
});
