import { describe, it, expect, vi } from "vitest";
import type { AirtableClient } from "@/lib/integrations/airtable";
import {
  computeFutureAccessParity,
  repairParityHoles,
  type ParityHole,
} from "@/lib/billing/future-access-parity";
import { STRIPE_CUSTOMER_ID_FIELD, SERVICE_ACCESS_FIELD } from "@/lib/billing/service-access-sync";

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
    const m = f.match(/IS_AFTER\([^,]+,\s*"(\d{4}-\d{2}-\d{2})"\)/);
    if (m) {
      const cutoff = new Date(`${m[1]}T00:00:00.000Z`).getTime();
      return records.filter((r) => {
        const v = r.fields[SERVICE_ACCESS_FIELD];
        return typeof v === "string" && new Date(v).getTime() > cutoff;
      });
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
  return {
    listRecords,
    updateRecordsBatched,
    updateRecords: vi.fn(),
    getRecord: vi.fn(),
    createRecords,
    createRecordsBatched: vi.fn(),
  } as unknown as AirtableClient & {
    listRecords: ReturnType<typeof vi.fn>;
    updateRecordsBatched: ReturnType<typeof vi.fn>;
    createRecords: ReturnType<typeof vi.fn>;
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
