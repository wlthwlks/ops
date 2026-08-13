import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const constructEvent = vi.fn();
const retrieveInvoice = vi.fn();
const listLineItems = vi.fn();
const retrieveCustomer = vi.fn();
const updateRecordsBatched = vi.fn();
const listRecords = vi.fn();
const createRecords = vi.fn();
const createRecordsBatched = vi.fn();

const retrieveSubscription = vi.fn();

vi.mock("@/lib/integrations/stripe", () => ({
  getStripeClient: () => ({
    webhooks: { constructEvent },
    invoices: {
      retrieve: retrieveInvoice,
      listLineItems,
    },
    customers: {
      retrieve: retrieveCustomer,
    },
    subscriptions: {
      retrieve: retrieveSubscription,
    },
  }),
  getStripeWebhookSecret: () => "whsec_test",
  getConfiguredMembershipPriceIds: () =>
    new Set(["price_membership", "prc_wlth-wlks-45-quarter-pdpa0cyx"]),
  getConfiguredMemberstackPlanId: () => "prc_wlth-wlks-45-quarter-pdpa0cyx",
  getStripeNativeMembershipPriceIds: () => new Set(["price_membership"]),
  hasNativeStripeMembershipPrices: () => true,
  membershipConfigIsMemberstackStyleOnly: () => false,
  parseMembershipPriceConfig: () => ({
    nativeStripePriceIds: ["price_membership"],
    memberstackCommerceIds: ["prc_wlth-wlks-45-quarter-pdpa0cyx"],
    allIds: ["price_membership", "prc_wlth-wlks-45-quarter-pdpa0cyx"],
  }),
}));

vi.mock("@/lib/integrations/airtable", () => ({
  createAirtableClient: () => ({
    listRecords,
    updateRecordsBatched,
    getRecord: vi.fn(),
    createRecords,
    createRecordsBatched,
    updateRecords: vi.fn(),
  }),
}));

import { POST } from "@/app/api/webhooks/stripe/route";

function makeRequest(body: string, signature: string | null = "t=1,v1=abc") {
  const headers = new Headers();
  if (signature) headers.set("stripe-signature", signature);
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers,
    body,
  }) as unknown as import("next/server").NextRequest;
}

function membershipLine(periodEnd: number) {
  return {
    id: "il_1",
    period: { start: periodEnd - 100, end: periodEnd },
    pricing: {
      price_details: { price: "price_membership", product: "prod" },
      type: "price_details",
      unit_amount_decimal: "1",
    },
  };
}

describe("POST /api/webhooks/stripe", () => {
  const prevAirtable = process.env.AIRTABLE_GET_DATA_TOKEN;
  const prevBase = process.env.AIRTABLE_BASE_ID;
  const prevRetry = process.env.STRIPE_MEMBER_REGISTRATION_RETRY_HOURS;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AIRTABLE_GET_DATA_TOKEN = "pat_test";
    process.env.AIRTABLE_BASE_ID = "appTEST";
    delete process.env.STRIPE_MEMBER_REGISTRATION_RETRY_HOURS;
    listLineItems.mockResolvedValue({ data: [], has_more: false });
    createRecords.mockResolvedValue([]);
    createRecordsBatched.mockResolvedValue([]);
  });

  afterEach(() => {
    if (prevAirtable === undefined) delete process.env.AIRTABLE_GET_DATA_TOKEN;
    else process.env.AIRTABLE_GET_DATA_TOKEN = prevAirtable;
    if (prevBase === undefined) delete process.env.AIRTABLE_BASE_ID;
    else process.env.AIRTABLE_BASE_ID = prevBase;
    if (prevRetry === undefined) delete process.env.STRIPE_MEMBER_REGISTRATION_RETRY_HOURS;
    else process.env.STRIPE_MEMBER_REGISTRATION_RETRY_HOURS = prevRetry;
  });

  it("returns 400 when signature missing", async () => {
    const res = await POST(makeRequest("{}", null));
    expect(res.status).toBe(400);
  });

  it("returns 400 when signature invalid", async () => {
    constructEvent.mockImplementation(() => {
      throw new Error("bad sig");
    });
    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(400);
  });

  it("ignores unrelated events with 200", async () => {
    constructEvent.mockReturnValue({
      id: "evt_1",
      type: "customer.subscription.deleted",
      data: { object: {} },
    });
    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ignored");
    expect(updateRecordsBatched).not.toHaveBeenCalled();
  });

  it("does not update on invoice.payment_failed style events", async () => {
    constructEvent.mockReturnValue({
      id: "evt_2",
      type: "invoice.payment_failed",
      data: { object: { id: "in_fail" } },
    });
    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    expect(updateRecordsBatched).not.toHaveBeenCalled();
  });

  it("updates Airtable on qualifying invoice.paid", async () => {
    const periodEnd = Math.floor(new Date("2026-09-01T00:00:00.000Z").getTime() / 1000);
    constructEvent.mockReturnValue({
      id: "evt_paid",
      type: "invoice.paid",
      data: { object: { id: "in_paid", customer: "cus_1", status: "paid" } },
    });
    retrieveInvoice.mockResolvedValue({
      id: "in_paid",
      customer: "cus_1",
      status: "paid",
      subscription: "sub_paid1",
      created: periodEnd - 1000,
      status_transitions: { paid_at: periodEnd - 500 },
    });
    listLineItems.mockResolvedValue({
      data: [membershipLine(periodEnd)],
      has_more: false,
    });
    retrieveSubscription.mockResolvedValue({
      id: "sub_paid1",
      status: "active",
      items: {
        data: [{ price: { id: "price_membership" } }],
      },
    });
    listRecords.mockResolvedValue([
      { id: "rec_m1", fields: { "Stripe Customer ID": "cus_1" } },
    ]);
    updateRecordsBatched.mockResolvedValue([{ id: "rec_m1", fields: {} }]);

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.processed).toBe(true);
    expect(json.status).toBe("updated");
    expect(json.airtableRecordsUpdated).toBe(1);
    expect(updateRecordsBatched).toHaveBeenCalled();
    const fields = updateRecordsBatched.mock.calls[0][1][0].fields as Record<
      string,
      unknown
    >;
    // Native Stripe price_ goes in "Stripe Price ID" — never the Memberstack commerce id.
    expect(fields["Stripe Price ID"]).toBe("price_membership");
    expect(fields["Stripe subscription status"]).toBe("active");
    expect(fields["Memberstack Plan ID"]).toBe("prc_wlth-wlks-45-quarter-pdpa0cyx");
    expect(fields["Stripe Subscription ID"]).toBe("sub_paid1");
    expect(createRecords).not.toHaveBeenCalled();
  });

  it("ignores paid invoice without membership price", async () => {
    constructEvent.mockReturnValue({
      id: "evt_x",
      type: "invoice.paid",
      data: { object: { id: "in_x", customer: "cus_1", status: "paid" } },
    });
    retrieveInvoice.mockResolvedValue({ id: "in_x", customer: "cus_1", status: "paid" });
    listLineItems.mockResolvedValue({
      data: [
        {
          id: "il_1",
          period: { start: 1, end: 2 },
          pricing: {
            price_details: { price: "price_other", product: "prod" },
            type: "price_details",
            unit_amount_decimal: "1",
          },
        },
      ],
      has_more: false,
    });

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ignored");
    expect(updateRecordsBatched).not.toHaveBeenCalled();
  });

  it("returns 503 member_registration_pending within retry window", async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 86400;
    const paidAt = Math.floor(Date.now() / 1000) - 60;
    constructEvent.mockReturnValue({
      id: "evt_nm",
      type: "invoice.paid",
      data: { object: { id: "in_nm", customer: "cus_missing", status: "paid" } },
    });
    retrieveInvoice.mockResolvedValue({
      id: "in_nm",
      customer: "cus_missing",
      status: "paid",
      created: paidAt,
      status_transitions: { paid_at: paidAt },
    });
    listLineItems.mockResolvedValue({
      data: [membershipLine(periodEnd)],
      has_more: false,
    });
    listRecords.mockResolvedValue([]);
    retrieveCustomer.mockResolvedValue({
      id: "cus_missing",
      email: "new@example.com",
      object: "customer",
    });

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.status).toBe("member_registration_pending");
    expect(json.shouldRetry).toBe(true);
    expect(createRecords).not.toHaveBeenCalled();
  });

  it("returns 200 stripe_member_not_found after retry window", async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 86400;
    const paidAt = Math.floor(Date.now() / 1000) - 48 * 3600;
    constructEvent.mockReturnValue({
      id: "evt_old",
      type: "invoice.paid",
      data: { object: { id: "in_old", customer: "cus_old", status: "paid" } },
    });
    retrieveInvoice.mockResolvedValue({
      id: "in_old",
      customer: "cus_old",
      status: "paid",
      created: paidAt,
      status_transitions: { paid_at: paidAt },
    });
    listLineItems.mockResolvedValue({
      data: [membershipLine(periodEnd)],
      has_more: false,
    });
    listRecords.mockResolvedValue([]);
    retrieveCustomer.mockResolvedValue({
      id: "cus_old",
      email: "old@example.com",
      object: "customer",
    });

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("stripe_member_not_found");
    expect(json.shouldRetry).toBe(false);
    expect(createRecords).not.toHaveBeenCalled();
    expect(updateRecordsBatched).not.toHaveBeenCalled();
  });

  it("does not link by email when Stripe Customer ID is missing on Airtable", async () => {
    const periodEnd = Math.floor(new Date("2026-09-01T00:00:00.000Z").getTime() / 1000);
    constructEvent.mockReturnValue({
      id: "evt_link",
      type: "invoice.paid",
      data: { object: { id: "in_link", customer: "cus_link", status: "paid" } },
    });
    retrieveInvoice.mockResolvedValue({
      id: "in_link",
      customer: "cus_link",
      status: "paid",
      created: periodEnd - 1000,
      status_transitions: { paid_at: periodEnd - 500 },
    });
    listLineItems.mockResolvedValue({
      data: [membershipLine(periodEnd)],
      has_more: false,
    });
    // Would have been email-linked under the old behaviour
    listRecords.mockResolvedValue([]);
    retrieveCustomer.mockResolvedValue({
      id: "cus_link",
      email: "link@example.com",
      object: "customer",
    });

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.status).toBe("member_registration_pending");
    expect(json.linkedStripeCustomerId).toBe(false);
    expect(updateRecordsBatched).not.toHaveBeenCalled();
    expect(createRecords).not.toHaveBeenCalled();
    expect(retrieveCustomer).not.toHaveBeenCalled();
  });

  it("never creates Airtable members from webhook", async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 86400;
    const paidAt = Math.floor(Date.now() / 1000) - 60;
    constructEvent.mockReturnValue({
      id: "evt_nc",
      type: "invoice.paid",
      data: { object: { id: "in_nc", customer: "cus_nc", status: "paid" } },
    });
    retrieveInvoice.mockResolvedValue({
      id: "in_nc",
      customer: "cus_nc",
      status: "paid",
      created: paidAt,
      status_transitions: { paid_at: paidAt },
    });
    listLineItems.mockResolvedValue({ data: [membershipLine(periodEnd)], has_more: false });
    listRecords.mockResolvedValue([]);
    retrieveCustomer.mockResolvedValue({ id: "cus_nc", email: "n@e.com", object: "customer" });

    await POST(makeRequest("{}"));
    expect(createRecords).not.toHaveBeenCalled();
    expect(createRecordsBatched).not.toHaveBeenCalled();
  });

  it("returns 500 on Airtable failure", async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 86400;
    constructEvent.mockReturnValue({
      id: "evt_fail",
      type: "invoice.paid",
      data: { object: { id: "in_f", customer: "cus_1", status: "paid" } },
    });
    retrieveInvoice.mockResolvedValue({
      id: "in_f",
      customer: "cus_1",
      status: "paid",
      created: periodEnd - 10,
      status_transitions: { paid_at: periodEnd - 5 },
    });
    listLineItems.mockResolvedValue({
      data: [membershipLine(periodEnd)],
      has_more: false,
    });
    listRecords.mockResolvedValue([{ id: "rec1", fields: { "Stripe Customer ID": "cus_1" } }]);
    updateRecordsBatched.mockRejectedValue(new Error("Airtable down"));

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(500);
  });

  it("returns 500 on Stripe retrieve failure", async () => {
    constructEvent.mockReturnValue({
      id: "evt_s",
      type: "invoice.paid",
      data: { object: { id: "in_s", customer: "cus_1", status: "paid" } },
    });
    retrieveInvoice.mockRejectedValue(new Error("stripe down"));

    const res = await POST(makeRequest("{}"));
    expect(res.status).toBe(500);
  });
});
