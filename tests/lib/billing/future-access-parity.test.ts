import { describe, it, expect, vi } from "vitest";
import type { AirtableClient } from "@/lib/integrations/airtable";
import {
  computeFutureAccessParity,
  repairParityHoles,
  repairParityExtras,
  type ParityHole,
  type ParityExtraRow,
} from "@/lib/billing/future-access-parity";
import {
  STRIPE_CUSTOMER_ID_FIELD,
  SERVICE_ACCESS_FIELD,
} from "@/lib/billing/service-access-sync";

const periodEnd = Math.floor(new Date("2026-09-01T00:00:00.000Z").getTime() / 1000);

function activeSub(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    status: "active",
    cancel_at_period_end: false,
    current_period_end: periodEnd,
    customer: { id: "cus_1", object: "customer", email: "pay@example.com", name: "Pay User" },
    items: { data: [{ price: { id: "price_mem" } }] },
    ...overrides,
  } as never;
}

function mockStripe(subs: unknown[]) {
  return {
    subscriptions: {
      list: vi.fn(async ({ status }: { status: string }) => ({
        data: status === "active" ? subs : [],
        has_more: false,
      })),
    },
  };
}

function mockAirtable(records: Array<{ id: string; fields: Record<string, unknown> }>) {
  const listRecords = vi.fn(async (_t: string, o?: { filterByFormula?: string }) => {
    const f = o?.filterByFormula || "";
    const future = f.match(/IS_AFTER\([^,]+,\s*"(\d{4}-\d{2}-\d{2})"\)/);
    if (future) {
      const cutoff = new Date(`${future[1]}T00:00:00.000Z`).getTime();
      return records.filter((r) => {
        const v = r.fields[SERVICE_ACCESS_FIELD];
        return typeof v === "string" && new Date(v).getTime() > cutoff;
      });
    }
    const cusMatch = f.match(/\{Stripe Customer ID\}\s*=\s*"([^"]+)"/);
    if (cusMatch) {
      return records.filter(
        (r) => String(r.fields[STRIPE_CUSTOMER_ID_FIELD] ?? "").trim() === cusMatch[1]
      );
    }
    const emailMatch = f.match(/LOWER\(\{email\}\)\s*=\s*"([^"]+)"/);
    if (emailMatch) {
      const want = emailMatch[1].toLowerCase();
      return records.filter(
        (r) => String(r.fields.email ?? "").trim().toLowerCase() === want
      );
    }
    return records;
  });
  const updateRecordsBatched = vi.fn(async (_t: string, u: Array<{ id: string }>) =>
    u.map((x) => ({ id: x.id, fields: {} }))
  );
  const createRecords = vi.fn(
    async (_t: string, recs: Array<{ fields: Record<string, unknown> }>) =>
      recs.map((r, i) => ({ id: `rec_new_${i}`, fields: r.fields }))
  );
  const getRecord = vi.fn(async (_t: string, id: string) => {
    const r = records.find((x) => x.id === id);
    if (!r) throw new Error(`record ${id} not found`);
    return { ...r, createdTime: "2026-01-01T00:00:00.000Z" };
  });
  return {
    listRecords,
    updateRecordsBatched,
    updateRecords: vi.fn(),
    getRecord,
    createRecords,
    createRecordsBatched: vi.fn(),
  } as unknown as AirtableClient & {
    listRecords: ReturnType<typeof vi.fn>;
    updateRecordsBatched: ReturnType<typeof vi.fn>;
    createRecords: ReturnType<typeof vi.fn>;
    getRecord: ReturnType<typeof vi.fn>;
  };
}

function hole(overrides: Partial<ParityHole> = {}): ParityHole {
  return {
    membership: {
      subscriptionId: "sub_1",
      subscriptionStatus: "active",
      cancelAtPeriodEnd: false,
      stripeCustomerId: "cus_1",
      customer: {
        id: "cus_1",
        object: "customer",
        email: "pay@example.com",
        name: "Pay User",
      } as never,
      priceIds: ["price_mem"],
      currentPeriodEndUnix: periodEnd,
    },
    email: "pay@example.com",
    currentPeriodEndIso: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("computeFutureAccessParity", () => {
  it("is clean when the only record matches the qualifying customer", async () => {
    const stripe = mockStripe([activeSub()]);
    const airtable = mockAirtable([
      { id: "rec1", fields: { [STRIPE_CUSTOMER_ID_FIELD]: "cus_1", [SERVICE_ACCESS_FIELD]: "2026-09-01T00:00:00.000Z", email: "pay@example.com" } },
    ]);
    const p = await computeFutureAccessParity({
      stripe,
      airtable,
      membershipPriceIds: new Set(["price_mem"]),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });
    expect(p.airtableFutureAccess).toBe(1);
    expect(p.stripeQualifying).toBe(1);
    expect(p.delta).toBe(0);
    expect(p.extras).toEqual([]);
    expect(p.holes).toEqual([]);
  });

  it("flags a record whose cus id is not in the qualifying set", async () => {
    const stripe = mockStripe([activeSub()]);
    const airtable = mockAirtable([
      { id: "rec1", fields: { [STRIPE_CUSTOMER_ID_FIELD]: "cus_1", [SERVICE_ACCESS_FIELD]: "2026-09-01T00:00:00.000Z" } },
      { id: "rec2", fields: { [STRIPE_CUSTOMER_ID_FIELD]: "cus_zzz", [SERVICE_ACCESS_FIELD]: "2026-12-01T00:00:00.000Z", email: "other@example.com" } },
    ]);
    const p = await computeFutureAccessParity({
      stripe,
      airtable,
      membershipPriceIds: new Set(["price_mem"]),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });
    expect(p.extras).toHaveLength(1);
    expect(p.extras[0].airtableRecordId).toBe("rec2");
    expect(p.extras[0].reason).toBe("cus_id_not_in_qualifying_set");
    expect(p.holes).toEqual([]);
    expect(p.delta).toBe(1);
  });

  it("flags blank cus id as no_stripe_customer_id", async () => {
    const stripe = mockStripe([activeSub()]);
    const airtable = mockAirtable([
      { id: "rec1", fields: { [STRIPE_CUSTOMER_ID_FIELD]: "cus_1", [SERVICE_ACCESS_FIELD]: "2026-09-01T00:00:00.000Z" } },
      { id: "rec2", fields: { [SERVICE_ACCESS_FIELD]: "2026-12-01T00:00:00.000Z" } },
    ]);
    const p = await computeFutureAccessParity({
      stripe,
      airtable,
      membershipPriceIds: new Set(["price_mem"]),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });
    expect(p.extras).toHaveLength(1);
    expect(p.extras[0].reason).toBe("no_stripe_customer_id");
  });

  it("flags duplicate records sharing a qualifying cus id", async () => {
    const stripe = mockStripe([activeSub()]);
    const airtable = mockAirtable([
      { id: "rec1", fields: { [STRIPE_CUSTOMER_ID_FIELD]: "cus_1", [SERVICE_ACCESS_FIELD]: "2026-09-01T00:00:00.000Z" } },
      { id: "rec2", fields: { [STRIPE_CUSTOMER_ID_FIELD]: "cus_1", [SERVICE_ACCESS_FIELD]: "2026-10-01T00:00:00.000Z" } },
    ]);
    const p = await computeFutureAccessParity({
      stripe,
      airtable,
      membershipPriceIds: new Set(["price_mem"]),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });
    expect(p.duplicates).toEqual([{ stripeCustomerId: "cus_1", count: 2 }]);
    expect(p.extras).toHaveLength(2);
    expect(p.extras.every((e) => e.reason === "duplicate_airtable_record")).toBe(true);
    expect(p.holes).toEqual([]);
  });

  it("flags a hole when the qualifying customer has no future-access record", async () => {
    const stripe = mockStripe([activeSub()]);
    const airtable = mockAirtable([
      { id: "rec1", fields: { [STRIPE_CUSTOMER_ID_FIELD]: "cus_1", [SERVICE_ACCESS_FIELD]: "2026-01-01T00:00:00.000Z" } },
    ]);
    const p = await computeFutureAccessParity({
      stripe,
      airtable,
      membershipPriceIds: new Set(["price_mem"]),
      now: new Date("2026-08-16T00:00:00.000Z"),
    });
    expect(p.holes).toHaveLength(1);
    expect(p.holes[0].email).toBe("pay@example.com");
    expect(p.extras).toEqual([]);
    expect(p.delta).toBe(-1);
  });
});

describe("repairParityHoles", () => {
  it("extends access on the matched record (monotonic)", async () => {
    const airtable = mockAirtable([
      { id: "rec1", fields: { [STRIPE_CUSTOMER_ID_FIELD]: "cus_1" } },
    ]);
    const r = await repairParityHoles({ airtable, holes: [hole()] });
    expect(r.fixed).toBe(1);
    expect(r.failed).toEqual([]);
    expect(airtable.updateRecordsBatched).toHaveBeenCalled();
    expect(airtable.createRecords).not.toHaveBeenCalled();
  });

  it("creates a missing member when enabled", async () => {
    const airtable = mockAirtable([]);
    const r = await repairParityHoles({ airtable, holes: [hole()] });
    expect(r.fixed).toBe(1);
    expect(airtable.createRecords).toHaveBeenCalled();
  });

  it("records failures without throwing", async () => {
    const airtable = mockAirtable([]);
    airtable.createRecords.mockRejectedValue(new Error("boom"));
    const r = await repairParityHoles({ airtable, holes: [hole()] });
    expect(r.fixed).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].reason).toContain("boom");
  });

  it("respects maxHoles", async () => {
    const airtable = mockAirtable([]);
    const holes = [hole(), hole({ email: "second@example.com" }), hole({ email: "third@example.com" })];
    const r = await repairParityHoles({ airtable, holes, maxHoles: 2 });
    expect(r.fixed).toBe(2);
    expect(airtable.createRecords).toHaveBeenCalledTimes(2);
  });
});

describe("repairParityExtras", () => {
  function extra(overrides: Partial<ParityExtraRow> = {}): ParityExtraRow {
    return {
      airtableRecordId: "rec2",
      email: "",
      name: "",
      stripeCustomerId: "cus_zzz",
      accessUntil: "2026-12-01T00:00:00.000Z",
      payment: "",
      membership: "",
      reason: "cus_id_not_in_qualifying_set",
      ...overrides,
    };
  }

  function membership(overrides: Record<string, unknown> = {}) {
    return {
      subscriptionId: "sub_1",
      subscriptionStatus: "active",
      cancelAtPeriodEnd: false,
      stripeCustomerId: "cus_1",
      customer: {
        id: "cus_1",
        object: "customer",
        email: "pay@example.com",
        name: "Pay User",
      } as never,
      priceIds: ["price_mem"],
      currentPeriodEndUnix: periodEnd,
      ...overrides,
    } as never;
  }

  function mockExtrasStripe(invoices: unknown[] = [], lines: unknown[] = []) {
    return {
      invoices: {
        list: vi.fn(async () => ({ data: invoices, has_more: false })),
        listLineItems: vi.fn(async () => ({ data: lines, has_more: false })),
      },
      subscriptions: {
        list: vi.fn(async () => ({ data: [], has_more: false })),
      },
    } as never;
  }

  it("clears future access when Stripe has no entitlement for the cus id", async () => {
    const stripe = mockExtrasStripe();
    const airtable = mockAirtable([
      {
        id: "rec2",
        fields: {
          [STRIPE_CUSTOMER_ID_FIELD]: "cus_zzz",
          [SERVICE_ACCESS_FIELD]: "2026-12-01T00:00:00.000Z",
        },
      },
    ]);
    const r = await repairParityExtras({
      stripe,
      airtable,
      extras: [extra()],
      qualifyingMemberships: [membership()],
      membershipPriceIds: new Set(["price_mem"]),
    });
    expect(r.cleared).toBe(1);
    expect(r.corrected).toBe(0);
    expect(r.fixed).toBe(1);
    const written = airtable.updateRecordsBatched.mock.calls[0][1];
    expect(written[0].id).toBe("rec2");
    expect(written[0].fields[SERVICE_ACCESS_FIELD]).toBeNull();
  });

  it("never touches a paused member (pause date set)", async () => {
    const stripe = mockExtrasStripe(
      [{ id: "in_1" }],
      [{ pricing: { price_details: { price: "price_mem" } }, period: { end: periodEnd } }]
    );
    const airtable = mockAirtable([
      {
        id: "rec2",
        fields: {
          [STRIPE_CUSTOMER_ID_FIELD]: "cus_zzz",
          [SERVICE_ACCESS_FIELD]: "2026-12-01T00:00:00.000Z",
          "Billing pause until": "2027-01-22",
          Membership: "Paused",
          "Stripe subscription status": "paused",
        },
      },
    ]);
    const r = await repairParityExtras({
      stripe,
      airtable,
      extras: [extra()],
      qualifyingMemberships: [membership()],
      membershipPriceIds: new Set(["price_mem"]),
    });
    expect(r.skipped).toBe(1);
    expect(r.corrected).toBe(0);
    expect(r.cleared).toBe(0);
    expect(airtable.updateRecordsBatched).not.toHaveBeenCalled();
  });

  it("corrects future access to Stripe paid-through (reduction allowed)", async () => {
    const invoiceEnd = Math.floor(new Date("2026-08-01T00:00:00.000Z").getTime() / 1000);
    const stripe = mockExtrasStripe(
      [{ id: "in_1" }],
      [{ pricing: { price_details: { price: "price_mem" } }, period: { end: invoiceEnd } }]
    );
    const airtable = mockAirtable([
      {
        id: "rec2",
        fields: {
          [STRIPE_CUSTOMER_ID_FIELD]: "cus_zzz",
          [SERVICE_ACCESS_FIELD]: "2026-12-01T00:00:00.000Z",
        },
      },
    ]);
    const r = await repairParityExtras({
      stripe,
      airtable,
      extras: [extra()],
      qualifyingMemberships: [membership()],
      membershipPriceIds: new Set(["price_mem"]),
    });
    expect(r.corrected).toBe(1);
    expect(r.cleared).toBe(0);
    const written = airtable.updateRecordsBatched.mock.calls[0][1];
    expect(written[0].fields[SERVICE_ACCESS_FIELD]).toBe("2026-08-01T00:00:00.000Z");
  });

  it("links a blank customer id via unique email to a qualifying membership", async () => {
    const stripe = mockExtrasStripe();
    const airtable = mockAirtable([
      {
        id: "rec2",
        fields: {
          email: "pay@example.com",
          [SERVICE_ACCESS_FIELD]: "2026-12-01T00:00:00.000Z",
        },
      },
    ]);
    const r = await repairParityExtras({
      stripe,
      airtable,
      extras: [
        extra({
          stripeCustomerId: "",
          reason: "no_stripe_customer_id",
          email: "pay@example.com",
        }),
      ],
      qualifyingMemberships: [membership()],
      membershipPriceIds: new Set(["price_mem"]),
    });
    expect(r.linked).toBe(1);
    expect(r.fixed).toBe(1);
    expect(r.failed).toEqual([]);
  });

  it("clears a blank customer id with no qualifying email match", async () => {
    const stripe = mockExtrasStripe();
    const airtable = mockAirtable([
      {
        id: "rec2",
        fields: {
          email: "ghost@example.com",
          [SERVICE_ACCESS_FIELD]: "2026-12-01T00:00:00.000Z",
        },
      },
    ]);
    const r = await repairParityExtras({
      stripe,
      airtable,
      extras: [
        extra({
          stripeCustomerId: "",
          reason: "no_stripe_customer_id",
          email: "ghost@example.com",
        }),
      ],
      qualifyingMemberships: [membership()],
      membershipPriceIds: new Set(["price_mem"]),
    });
    expect(r.cleared).toBe(1);
    expect(r.linked).toBe(0);
    const written = airtable.updateRecordsBatched.mock.calls[0][1];
    expect(written[0].fields[SERVICE_ACCESS_FIELD]).toBeNull();
  });

  it("keeps one duplicate row (email match preferred) and clears the others", async () => {
    const stripe = mockExtrasStripe();
    const airtable = mockAirtable([
      {
        id: "rec_a",
        fields: {
          email: "a@example.com",
          [STRIPE_CUSTOMER_ID_FIELD]: "cus_1",
          [SERVICE_ACCESS_FIELD]: "2026-10-01T00:00:00.000Z",
        },
      },
      {
        id: "rec_b",
        fields: {
          email: "pay@example.com",
          [STRIPE_CUSTOMER_ID_FIELD]: "cus_1",
          [SERVICE_ACCESS_FIELD]: "2026-09-01T00:00:00.000Z",
        },
      },
    ]);
    const r = await repairParityExtras({
      stripe,
      airtable,
      extras: [
        extra({
          airtableRecordId: "rec_a",
          stripeCustomerId: "cus_1",
          reason: "duplicate_airtable_record",
          email: "a@example.com",
          accessUntil: "2026-10-01T00:00:00.000Z",
        }),
        extra({
          airtableRecordId: "rec_b",
          stripeCustomerId: "cus_1",
          reason: "duplicate_airtable_record",
          email: "pay@example.com",
          accessUntil: "2026-09-01T00:00:00.000Z",
        }),
      ],
      qualifyingMemberships: [membership()],
      membershipPriceIds: new Set(["price_mem"]),
    });
    expect(r.cleared).toBe(1);
    expect(r.skipped).toBe(1);
    const written = airtable.updateRecordsBatched.mock.calls[0][1];
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe("rec_a");
    expect(written[0].fields[SERVICE_ACCESS_FIELD]).toBeNull();
  });

  it("skips rows that changed since the parity scan", async () => {
    const stripe = mockExtrasStripe();
    const airtable = mockAirtable([
      {
        id: "rec2",
        fields: {
          [STRIPE_CUSTOMER_ID_FIELD]: "cus_zzz",
          [SERVICE_ACCESS_FIELD]: "2027-01-01T00:00:00.000Z",
        },
      },
    ]);
    const r = await repairParityExtras({
      stripe,
      airtable,
      extras: [extra()],
      qualifyingMemberships: [membership()],
      membershipPriceIds: new Set(["price_mem"]),
    });
    expect(r.skipped).toBe(1);
    expect(r.fixed).toBe(0);
    expect(airtable.updateRecordsBatched).not.toHaveBeenCalled();
  });

  it("respects maxExtras", async () => {
    const stripe = mockExtrasStripe();
    const airtable = mockAirtable([
      {
        id: "rec2",
        fields: {
          [STRIPE_CUSTOMER_ID_FIELD]: "cus_zzz",
          [SERVICE_ACCESS_FIELD]: "2026-12-01T00:00:00.000Z",
        },
      },
      {
        id: "rec3",
        fields: {
          [STRIPE_CUSTOMER_ID_FIELD]: "cus_yyy",
          [SERVICE_ACCESS_FIELD]: "2026-12-02T00:00:00.000Z",
        },
      },
      {
        id: "rec4",
        fields: {
          [STRIPE_CUSTOMER_ID_FIELD]: "cus_xxx",
          [SERVICE_ACCESS_FIELD]: "2026-12-03T00:00:00.000Z",
        },
      },
    ]);
    const r = await repairParityExtras({
      stripe,
      airtable,
      extras: [
        extra(),
        extra({ airtableRecordId: "rec3", stripeCustomerId: "cus_yyy", accessUntil: "2026-12-02T00:00:00.000Z" }),
        extra({ airtableRecordId: "rec4", stripeCustomerId: "cus_xxx", accessUntil: "2026-12-03T00:00:00.000Z" }),
      ],
      qualifyingMemberships: [membership()],
      membershipPriceIds: new Set(["price_mem"]),
      maxExtras: 2,
    });
    expect(r.fixed).toBe(2);
    const written = airtable.updateRecordsBatched.mock.calls[0][1];
    expect(written).toHaveLength(2);
  });

  it("reports entitlement lookup failures without throwing", async () => {
    const stripe = {
      invoices: {
        list: vi.fn(async () => {
          throw new Error("stripe down");
        }),
        listLineItems: vi.fn(async () => ({ data: [], has_more: false })),
      },
      subscriptions: {
        list: vi.fn(async () => ({ data: [], has_more: false })),
      },
    } as never;
    const airtable = mockAirtable([
      {
        id: "rec2",
        fields: {
          [STRIPE_CUSTOMER_ID_FIELD]: "cus_zzz",
          [SERVICE_ACCESS_FIELD]: "2026-12-01T00:00:00.000Z",
        },
      },
    ]);
    const r = await repairParityExtras({
      stripe,
      airtable,
      extras: [extra()],
      qualifyingMemberships: [membership()],
      membershipPriceIds: new Set(["price_mem"]),
    });
    expect(r.fixed).toBe(0);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0].reason).toContain("stripe down");
  });
});
