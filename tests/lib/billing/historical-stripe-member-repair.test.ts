import { describe, it, expect, vi } from "vitest";
import type { AirtableClient } from "@/lib/integrations/airtable";
import {
  parseHistoricalRepairArgs,
  repairPayingStripeCustomer,
  repairActiveSubscription,
  listActiveMembershipSubscriptions,
  namesFromStripeCustomer,
  type ActiveMembershipSubscription,
} from "@/lib/billing/historical-stripe-member-repair";
import {
  STRIPE_CUSTOMER_ID_FIELD,
  SERVICE_ACCESS_FIELD,
  PAYMENT_FIELD,
  MEMBERSHIP_FIELD,
  STRIPE_SUBSCRIPTION_ID_FIELD,
  STRIPE_SUBSCRIPTION_STATUS_FIELD,
  CANCEL_AT_PERIOD_END_FIELD,
  CANCELLATION_EFFECTIVE_AT_FIELD,
  CANCELLATION_DATE_FIELD,
} from "@/lib/billing/service-access-sync";

describe("parseHistoricalRepairArgs", () => {
  it("defaults to dry-run", () => {
    const a = parseHistoricalRepairArgs([]);
    expect(a.dryRun).toBe(true);
    expect(a.canLink).toBe(false);
    expect(a.canCreate).toBe(false);
    expect(a.subscriptions).toBe(false);
  });

  it("subscriptions flag switches driver + default output", () => {
    const a = parseHistoricalRepairArgs(["--subscriptions"]);
    expect(a.subscriptions).toBe(true);
    expect(a.output).toBe("tmp/active-subscription-sync.csv");
  });

  it("apply-links enables link writes without create", () => {
    const a = parseHistoricalRepairArgs(["--apply-links"]);
    expect(a.dryRun).toBe(false);
    expect(a.canLink).toBe(true);
    expect(a.canCreate).toBe(false);
  });

  it("apply without create-missing does not create", () => {
    const a = parseHistoricalRepairArgs(["--apply"]);
    expect(a.canLink).toBe(true);
    expect(a.canCreate).toBe(false);
  });

  it("apply + create-missing enables create", () => {
    const a = parseHistoricalRepairArgs(["--apply", "--create-missing"]);
    expect(a.canCreate).toBe(true);
    expect(a.dryRun).toBe(false);
  });

  it("rejects create-missing without apply", () => {
    expect(() => parseHistoricalRepairArgs(["--create-missing"])).toThrow(/requires --apply/);
  });
});

describe("namesFromStripeCustomer", () => {
  it("splits customer name into first and last", () => {
    expect(
      namesFromStripeCustomer({ name: "Ada Lovelace", id: "cus_1" } as never, "a@b.com")
    ).toEqual({ firstName: "Ada", lastName: "Lovelace" });
  });

  it("keeps middle words in last name", () => {
    expect(
      namesFromStripeCustomer({ name: "Ada Marie Lovelace", id: "cus_1" } as never, "a@b.com")
    ).toEqual({ firstName: "Ada", lastName: "Marie Lovelace" });
  });

  it("falls back to email local part as first name", () => {
    expect(namesFromStripeCustomer({ id: "cus_1" } as never, "ada@b.com")).toEqual({
      firstName: "ada",
      lastName: "",
    });
  });
});

describe("repairPayingStripeCustomer", () => {
  const membershipPriceIds = new Set(["price_mem"]);
  const periodEnd = Math.floor(new Date("2026-09-01T00:00:00.000Z").getTime() / 1000);

  function mockStripe(subscriptionsData: unknown[] | null = []) {
    return {
      customers: {
        list: vi.fn(),
        retrieve: vi.fn(),
      },
      subscriptions: {
        list: vi.fn(async () => ({
          data: subscriptionsData ?? [],
          has_more: false,
        })),
      },
      invoices: {
        list: vi.fn(async () => ({
          data: [{ id: "in_1" }],
          has_more: false,
        })),
        listLineItems: vi.fn(async () => ({
          data: [
            {
              id: "il_1",
              period: { start: periodEnd - 100, end: periodEnd },
              pricing: {
                price_details: { price: "price_mem", product: "p" },
                type: "price_details",
                unit_amount_decimal: "1",
              },
            },
          ],
          has_more: false,
        })),
      },
    };
  }

  function mockAirtable(opts: {
    byId?: Array<{ id: string; fields: Record<string, unknown> }>;
    byEmail?: Array<{ id: string; fields: Record<string, unknown> }>;
  }) {
    const updateRecordsBatched = vi.fn(async (_t: string, u: Array<{ id: string }>) =>
      u.map((x) => ({ id: x.id, fields: {} }))
    );
    const createRecords = vi.fn(async (_t: string, recs: Array<{ fields: Record<string, unknown> }>) =>
      recs.map((r, i) => ({ id: `rec_new_${i}`, fields: r.fields }))
    );
    const listRecords = vi.fn(async (_t: string, o?: { filterByFormula?: string }) => {
      const f = o?.filterByFormula || "";
      if (f.includes("Stripe Customer ID")) return opts.byId ?? [];
      if (f.includes("LOWER") || f.includes("email")) return opts.byEmail ?? [];
      return [];
    });
    return {
      listRecords,
      updateRecordsBatched,
      createRecords,
      createRecordsBatched: vi.fn(),
      getRecord: vi.fn(),
      updateRecords: vi.fn(),
    } as unknown as AirtableClient & {
      listRecords: ReturnType<typeof vi.fn>;
      updateRecordsBatched: ReturnType<typeof vi.fn>;
      createRecords: ReturnType<typeof vi.fn>;
    };
  }

  const customer = {
    id: "cus_1",
    object: "customer" as const,
    email: "pay@example.com",
    name: "Pay User",
  };

  it("updates access when already linked", async () => {
    const airtable = mockAirtable({
      byId: [{ id: "rec1", fields: { [STRIPE_CUSTOMER_ID_FIELD]: "cus_1" } }],
    });
    const stripe = mockStripe();
    const r = await repairPayingStripeCustomer({
      airtable,
      stripe,
      customer: customer as never,
      membershipPriceIds,
      canLink: true,
      canCreate: false,
      dryRun: false,
    });
    expect(r.action).toBe("updated_access");
    expect(r.created).toBe(false);
    expect(airtable.createRecords).not.toHaveBeenCalled();
  });

  it("links on unique email when canLink", async () => {
    let idLookups = 0;
    const airtable = mockAirtable({ byId: [], byEmail: [{ id: "rec_e", fields: { email: "pay@example.com" } }] });
    airtable.listRecords.mockImplementation(async (_t: string, o?: { filterByFormula?: string }) => {
      const f = o?.filterByFormula || "";
      if (f.includes("Stripe Customer ID")) {
        idLookups++;
        if (idLookups === 1) return [];
        return [{ id: "rec_e", fields: { [STRIPE_CUSTOMER_ID_FIELD]: "cus_1" } }];
      }
      return [{ id: "rec_e", fields: { email: "pay@example.com" } }];
    });
    const stripe = mockStripe();
    const r = await repairPayingStripeCustomer({
      airtable,
      stripe,
      customer: customer as never,
      membershipPriceIds,
      canLink: true,
      canCreate: false,
      dryRun: false,
    });
    expect(r.action).toBe("linked_and_updated");
    expect(r.linked).toBe(true);
    expect(airtable.createRecords).not.toHaveBeenCalled();
  });

  it("does not create without canCreate", async () => {
    const airtable = mockAirtable({ byId: [], byEmail: [] });
    const stripe = mockStripe();
    const r = await repairPayingStripeCustomer({
      airtable,
      stripe,
      customer: customer as never,
      membershipPriceIds,
      canLink: true,
      canCreate: false,
      dryRun: false,
    });
    expect(r.action).toBe("skipped_create_not_enabled");
    expect(airtable.createRecords).not.toHaveBeenCalled();
  });

  it("creates only when canCreate", async () => {
    const airtable = mockAirtable({ byId: [], byEmail: [] });
    const stripe = mockStripe([
      {
        id: "sub_c1",
        status: "canceled",
        cancel_at_period_end: false,
        current_period_end: periodEnd - 1000,
        canceled_at: periodEnd,
        items: { data: [{ price: { id: "price_mem" } }] },
      },
    ]);
    const r = await repairPayingStripeCustomer({
      airtable,
      stripe,
      customer: customer as never,
      membershipPriceIds,
      canLink: true,
      canCreate: true,
      dryRun: false,
    });
    expect(r.action).toBe("created_member");
    expect(r.created).toBe(true);
    expect(airtable.createRecords).toHaveBeenCalledWith(
      "MEMBERS",
      expect.arrayContaining([
        expect.objectContaining({
          fields: expect.objectContaining({
            email: "pay@example.com",
            [STRIPE_CUSTOMER_ID_FIELD]: "cus_1",
            [SERVICE_ACCESS_FIELD]: "2026-09-01T00:00:00.000Z",
            "First Name": "Pay",
            "Last Name": "User",
            [MEMBERSHIP_FIELD]: "Cancelled",
            [PAYMENT_FIELD]: "Paid",
          }),
        }),
      ])
    );
    const createdFields = (
      airtable.createRecords.mock.calls[0][1] as Array<{ fields: Record<string, unknown> }>
    )[0].fields;
    expect(createdFields).not.toHaveProperty("Name");
  });

  it("create sets Cancellation date + effective-at from a cancelled subscription", async () => {
    const airtable = mockAirtable({ byId: [], byEmail: [] });
    const stripe = mockStripe([
      {
        id: "sub_c1",
        status: "canceled",
        cancel_at_period_end: true,
        current_period_end: periodEnd - 1000,
        canceled_at: periodEnd,
        items: { data: [{ price: { id: "price_mem" } }] },
      },
    ]);
    await repairPayingStripeCustomer({
      airtable,
      stripe,
      customer: customer as never,
      membershipPriceIds,
      canLink: true,
      canCreate: true,
      dryRun: false,
    });
    const createdFields = (
      airtable.createRecords.mock.calls[0][1] as Array<{ fields: Record<string, unknown> }>
    )[0].fields;
    expect(createdFields[MEMBERSHIP_FIELD]).toBe("Cancelled");
    expect(createdFields[PAYMENT_FIELD]).toBe("Paid");
    expect(createdFields[CANCELLATION_DATE_FIELD]).toBe("2026-09-01");
    expect(createdFields[CANCELLATION_EFFECTIVE_AT_FIELD]).toBe("2026-09-01T00:00:00.000Z");
    expect(createdFields[CANCEL_AT_PERIOD_END_FIELD]).toBe(true);
    expect(createdFields[STRIPE_SUBSCRIPTION_ID_FIELD]).toBe("sub_c1");
    expect(createdFields[STRIPE_SUBSCRIPTION_STATUS_FIELD]).toBe("canceled");
  });

  it("create sets Active/Paid with no cancellation fields for an active subscription", async () => {
    const airtable = mockAirtable({ byId: [], byEmail: [] });
    const stripe = mockStripe([
      {
        id: "sub_a1",
        status: "active",
        cancel_at_period_end: false,
        current_period_end: periodEnd,
        items: { data: [{ price: { id: "price_mem" } }] },
      },
    ]);
    await repairPayingStripeCustomer({
      airtable,
      stripe,
      customer: customer as never,
      membershipPriceIds,
      canLink: true,
      canCreate: true,
      dryRun: false,
    });
    const createdFields = (
      airtable.createRecords.mock.calls[0][1] as Array<{ fields: Record<string, unknown> }>
    )[0].fields;
    expect(createdFields[MEMBERSHIP_FIELD]).toBe("Active");
    expect(createdFields[PAYMENT_FIELD]).toBe("Paid");
    expect(createdFields[CANCELLATION_DATE_FIELD]).toBeUndefined();
    expect(createdFields[CANCELLATION_EFFECTIVE_AT_FIELD]).toBeUndefined();
    expect(createdFields[STRIPE_SUBSCRIPTION_ID_FIELD]).toBe("sub_a1");
    expect(createdFields[STRIPE_SUBSCRIPTION_STATUS_FIELD]).toBe("active");
  });

  it("create skips status fields when subscriptions cannot be inspected", async () => {
    const airtable = mockAirtable({ byId: [], byEmail: [] });
    const stripe = mockStripe();
    stripe.subscriptions.list.mockRejectedValueOnce(new Error("boom"));
    const r = await repairPayingStripeCustomer({
      airtable,
      stripe,
      customer: customer as never,
      membershipPriceIds,
      canLink: true,
      canCreate: true,
      dryRun: false,
    });
    expect(r.action).toBe("created_member");
    const createdFields = (
      airtable.createRecords.mock.calls[0][1] as Array<{ fields: Record<string, unknown> }>
    )[0].fields;
    expect(createdFields[MEMBERSHIP_FIELD]).toBeUndefined();
    expect(createdFields[PAYMENT_FIELD]).toBeUndefined();
    expect(createdFields[CANCELLATION_DATE_FIELD]).toBeUndefined();
  });

  it("dry-run never writes", async () => {
    const airtable = mockAirtable({ byId: [], byEmail: [] });
    const stripe = mockStripe();
    const r = await repairPayingStripeCustomer({
      airtable,
      stripe,
      customer: customer as never,
      membershipPriceIds,
      canLink: false,
      canCreate: false,
      dryRun: true,
    });
    expect(r.action).toBe("would_create_member");
    expect(airtable.createRecords).not.toHaveBeenCalled();
    expect(airtable.updateRecordsBatched).not.toHaveBeenCalled();
  });
});

describe("repairActiveSubscription", () => {
  const periodEnd = Math.floor(new Date("2026-09-01T00:00:00.000Z").getTime() / 1000);

  function membership(overrides: Partial<ActiveMembershipSubscription> = {}) {
    return {
      subscriptionId: "sub_1",
      subscriptionStatus: "active",
      cancelAtPeriodEnd: false,
      stripeCustomerId: "cus_1",
      customer: { id: "cus_1", object: "customer", email: "pay@example.com", name: "Pay User" },
      priceIds: ["price_mem"],
      currentPeriodEndUnix: periodEnd,
      ...overrides,
    } as ActiveMembershipSubscription;
  }

  function mockAirtable(opts: {
    byId?: Array<{ id: string; fields: Record<string, unknown> }>;
    byEmail?: Array<{ id: string; fields: Record<string, unknown> }>;
  }) {
    const updateRecordsBatched = vi.fn(async (_t: string, u: Array<{ id: string }>) =>
      u.map((x) => ({ id: x.id, fields: {} }))
    );
    const createRecords = vi.fn(async (_t: string, recs: Array<{ fields: Record<string, unknown> }>) =>
      recs.map((r, i) => ({ id: `rec_new_${i}`, fields: r.fields }))
    );
    const listRecords = vi.fn(async (_t: string, o?: { filterByFormula?: string }) => {
      const f = o?.filterByFormula || "";
      if (f.includes("Stripe Customer ID")) return opts.byId ?? [];
      if (f.includes("LOWER") || f.includes("email")) return opts.byEmail ?? [];
      return [];
    });
    return {
      listRecords,
      updateRecordsBatched,
      createRecords,
      createRecordsBatched: vi.fn(),
      getRecord: vi.fn(),
      updateRecords: vi.fn(),
    } as unknown as AirtableClient & {
      listRecords: ReturnType<typeof vi.fn>;
      updateRecordsBatched: ReturnType<typeof vi.fn>;
      createRecords: ReturnType<typeof vi.fn>;
    };
  }

  it("updates access from subscription period end when already linked", async () => {
    const airtable = mockAirtable({
      byId: [{ id: "rec1", fields: { [STRIPE_CUSTOMER_ID_FIELD]: "cus_1" } }],
    });
    const r = await repairActiveSubscription({
      airtable,
      customer: { id: "cus_1" } as never,
      membership: membership(),
      canLink: true,
      canCreate: false,
      dryRun: false,
    });
    expect(r.action).toBe("updated_access");
    expect(r.paidThrough).toBe("2026-09-01T00:00:00.000Z");
    expect(r.created).toBe(false);
    expect(airtable.createRecords).not.toHaveBeenCalled();
  });

  it("leaves Payment untouched for trialing subscriptions", async () => {
    const airtable = mockAirtable({
      byId: [{ id: "rec1", fields: { [STRIPE_CUSTOMER_ID_FIELD]: "cus_1" } }],
    });
    const r = await repairActiveSubscription({
      airtable,
      customer: { id: "cus_1" } as never,
      membership: membership({ subscriptionStatus: "trialing" }),
      canLink: true,
      canCreate: false,
      dryRun: false,
    });
    expect(r.action).toBe("updated_access");
    const updates = airtable.updateRecordsBatched.mock.calls[0][1] as Array<{
      fields: Record<string, unknown>;
    }>;
    expect(updates[0].fields).not.toHaveProperty(PAYMENT_FIELD);
    expect(updates[0].fields[MEMBERSHIP_FIELD]).toBe("Active");
  });

  it("links on unique email when canLink", async () => {
    let idLookups = 0;
    const m = membership();
    const airtable = mockAirtable({
      byId: [],
      byEmail: [{ id: "rec_e", fields: { email: "pay@example.com" } }],
    });
    airtable.listRecords.mockImplementation(async (_t: string, o?: { filterByFormula?: string }) => {
      const f = o?.filterByFormula || "";
      if (f.includes("Stripe Customer ID")) {
        idLookups++;
        if (idLookups === 1) return [];
        return [{ id: "rec_e", fields: { [STRIPE_CUSTOMER_ID_FIELD]: "cus_1" } }];
      }
      return [{ id: "rec_e", fields: { email: "pay@example.com" } }];
    });
    const r = await repairActiveSubscription({
      airtable,
      customer: m.customer as never,
      membership: m,
      canLink: true,
      canCreate: false,
      dryRun: false,
    });
    expect(r.action).toBe("linked_and_updated");
    expect(r.linked).toBe(true);
    expect(airtable.createRecords).not.toHaveBeenCalled();
  });

  it("creates when canCreate with subscription billing fields", async () => {
    const m = membership();
    const airtable = mockAirtable({ byId: [], byEmail: [] });
    const r = await repairActiveSubscription({
      airtable,
      customer: m.customer as never,
      membership: m,
      canLink: true,
      canCreate: true,
      dryRun: false,
    });
    expect(r.action).toBe("created_member");
    expect(r.created).toBe(true);
    expect(airtable.createRecords).toHaveBeenCalledWith(
      "MEMBERS",
      expect.arrayContaining([
        expect.objectContaining({
          fields: expect.objectContaining({
            email: "pay@example.com",
            [STRIPE_CUSTOMER_ID_FIELD]: "cus_1",
            [SERVICE_ACCESS_FIELD]: "2026-09-01T00:00:00.000Z",
            [PAYMENT_FIELD]: "Paid",
            [MEMBERSHIP_FIELD]: "Active",
            [STRIPE_SUBSCRIPTION_ID_FIELD]: "sub_1",
          }),
        }),
      ])
    );
    const createdFields = (
      airtable.createRecords.mock.calls[0][1] as Array<{ fields: Record<string, unknown> }>
    )[0].fields;
    expect(createdFields).not.toHaveProperty("Name");
    expect(createdFields).not.toHaveProperty("Cancellation effective at");
  });

  it("sets cancellation effective at when cancel_at_period_end", async () => {
    const m = membership({ cancelAtPeriodEnd: true });
    const airtable = mockAirtable({ byId: [], byEmail: [] });
    const r = await repairActiveSubscription({
      airtable,
      customer: m.customer as never,
      membership: m,
      canLink: true,
      canCreate: true,
      dryRun: false,
    });
    expect(r.action).toBe("created_member");
    const createdFields = (
      airtable.createRecords.mock.calls[0][1] as Array<{ fields: Record<string, unknown> }>
    )[0].fields;
    expect(createdFields["Cancellation effective at"]).toBe("2026-09-01T00:00:00.000Z");
  });

  it("skips when subscription has no current period end", async () => {
    const airtable = mockAirtable({ byId: [], byEmail: [] });
    const r = await repairActiveSubscription({
      airtable,
      customer: { id: "cus_1" } as never,
      membership: membership({ currentPeriodEndUnix: null }),
      canLink: true,
      canCreate: true,
      dryRun: false,
    });
    expect(r.action).toBe("skipped_no_period_end");
    expect(airtable.createRecords).not.toHaveBeenCalled();
  });

  it("dry-run never writes", async () => {
    const m = membership();
    const airtable = mockAirtable({ byId: [], byEmail: [] });
    const r = await repairActiveSubscription({
      airtable,
      customer: m.customer as never,
      membership: m,
      canLink: false,
      canCreate: false,
      dryRun: true,
    });
    expect(r.action).toBe("would_create_member");
    expect(airtable.createRecords).not.toHaveBeenCalled();
    expect(airtable.updateRecordsBatched).not.toHaveBeenCalled();
  });
});

describe("listActiveMembershipSubscriptions", () => {
  const periodEnd = Math.floor(new Date("2026-09-01T00:00:00.000Z").getTime() / 1000);

  function sub(overrides: Record<string, unknown>) {
    return {
      id: "sub_x",
      status: "active",
      cancel_at_period_end: false,
      current_period_end: periodEnd,
      customer: { id: "cus_x", object: "customer", email: "x@example.com", name: "X" },
      items: { data: [{ price: { id: "price_mem" } }] },
      ...overrides,
    } as never;
  }

  it("filters by allowlist and dedupes to best sub per customer", async () => {
    const stripe = {
      subscriptions: {
        list: vi.fn(async (params: { status?: string }) => {
          if (params.status === "active") {
            return {
              data: [
                sub({ id: "sub_a1", customer: { id: "cus_a" } }),
                sub({
                  id: "sub_a2",
                  customer: { id: "cus_a" },
                  current_period_end: periodEnd + 1000,
                }),
                sub({ id: "sub_b1", customer: { id: "cus_b" }, items: { data: [{ price: { id: "price_other" } }] } }),
              ],
              has_more: false,
            };
          }
          if (params.status === "trialing") {
            return {
              data: [
                sub({
                  id: "sub_t1",
                  status: "trialing",
                  customer: { id: "cus_t", email: "t@example.com", name: "T" },
                }),
              ],
              has_more: false,
            };
          }
          return { data: [], has_more: false };
        }),
      },
    };

    const out = await listActiveMembershipSubscriptions(
      stripe as never,
      new Set(["price_mem"])
    );
    expect(out).toHaveLength(2);
    const byCus = new Map(out.map((m) => [m.stripeCustomerId, m]));
    expect(byCus.get("cus_a")?.subscriptionId).toBe("sub_a2");
    expect(byCus.get("cus_a")?.currentPeriodEndUnix).toBe(periodEnd + 1000);
    expect(byCus.get("cus_t")?.subscriptionStatus).toBe("trialing");
    expect(byCus.has("cus_b")).toBe(false);
  });

  it("returns empty when no native price_ allowlist", async () => {
    const stripe = {
      subscriptions: { list: vi.fn(async () => ({ data: [], has_more: false })) },
    };
    const out = await listActiveMembershipSubscriptions(stripe as never, new Set(["prc_memberstack"]));
    expect(out).toHaveLength(0);
    expect(stripe.subscriptions.list).not.toHaveBeenCalled();
  });
});
