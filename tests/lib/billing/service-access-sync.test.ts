import { describe, it, expect, vi } from "vitest";
import type Stripe from "stripe";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import {
  escapeAirtableFormulaString,
  getLinePeriodEnd,
  getLinePriceId,
  getMembershipPeriodEnd,
  getStripeCustomerId,
  listPaidInvoicesForCustomer,
  computeLatestMembershipPeriodEndForCustomer,
  maxPaidThroughDate,
  updateServiceAccessUntilForCustomer,
  isValidStripeCustomerId,
  SERVICE_ACCESS_FIELD,
} from "@/lib/billing/service-access-sync";

function line(partial: {
  id?: string;
  priceId?: string | null;
  periodEnd?: number | null;
}): Stripe.InvoiceLineItem {
  const priceId = partial.priceId;
  return {
    id: partial.id ?? "il_1",
    object: "line_item",
    amount: 1000,
    currency: "usd",
    description: null,
    discount_amounts: null,
    discountable: true,
    discounts: [],
    invoice: null,
    livemode: false,
    metadata: {},
    parent: null,
    period: {
      start: (partial.periodEnd ?? 0) - 86400,
      end: partial.periodEnd ?? 0,
    },
    pretax_credit_amounts: null,
    pricing:
      priceId == null
        ? null
        : {
            price_details: {
              price: priceId,
              product: "prod_x",
            },
            type: "price_details",
            unit_amount_decimal: "1000",
          },
    quantity: 1,
    taxes: [],
  } as unknown as Stripe.InvoiceLineItem;
}

describe("escapeAirtableFormulaString", () => {
  it("escapes quotes and backslashes", () => {
    expect(escapeAirtableFormulaString('cus_ab"c')).toBe('cus_ab\\"c');
    expect(escapeAirtableFormulaString("a\\b")).toBe("a\\\\b");
  });
});

describe("getStripeCustomerId", () => {
  it("reads string customer ids", () => {
    expect(getStripeCustomerId("cus_123")).toBe("cus_123");
    expect(getStripeCustomerId("  cus_123  ")).toBe("cus_123");
    expect(getStripeCustomerId("not_a_cus")).toBe(null);
    expect(getStripeCustomerId(null)).toBe(null);
  });

  it("reads object customer ids", () => {
    expect(getStripeCustomerId({ id: "cus_abc", object: "customer" } as Stripe.Customer)).toBe(
      "cus_abc"
    );
    expect(
      getStripeCustomerId({ id: "cus_del", object: "customer", deleted: true } as Stripe.DeletedCustomer)
    ).toBe(null);
  });
});

describe("getLinePriceId / period end", () => {
  it("reads price from pricing.price_details", () => {
    expect(getLinePriceId(line({ priceId: "price_mem" }))).toBe("price_mem");
  });

  it("returns null without price", () => {
    expect(getLinePriceId(line({ priceId: null }))).toBe(null);
  });

  it("reads period end", () => {
    expect(getLinePeriodEnd(line({ periodEnd: 1700000000 }))).toBe(1700000000);
  });
});

describe("getMembershipPeriodEnd", () => {
  const prices = new Set(["price_monthly", "price_yearly"]);

  it("returns null when no membership price", () => {
    expect(
      getMembershipPeriodEnd([line({ priceId: "price_other", periodEnd: 100 })], prices)
    ).toBe(null);
  });

  it("ignores unrelated products", () => {
    expect(
      getMembershipPeriodEnd(
        [
          line({ priceId: "price_other", periodEnd: 999 }),
          line({ priceId: "price_monthly", periodEnd: 100 }),
        ],
        prices
      )
    ).toBe(100);
  });

  it("selects latest qualifying period end", () => {
    expect(
      getMembershipPeriodEnd(
        [
          line({ id: "a", priceId: "price_monthly", periodEnd: 100 }),
          line({ id: "b", priceId: "price_yearly", periodEnd: 500 }),
          line({ id: "c", priceId: "price_monthly", periodEnd: 200 }),
        ],
        prices
      )
    ).toBe(500);
  });
});

describe("maxPaidThroughDate", () => {
  const sep1 = Math.floor(new Date("2026-09-01T00:00:00.000Z").getTime() / 1000);
  const aug1 = Math.floor(new Date("2026-08-01T00:00:00.000Z").getTime() / 1000);

  it("updates blank", () => {
    const r = maxPaidThroughDate(null, sep1);
    expect(r.shouldUpdate).toBe(true);
    expect(r.reason).toContain("Blank");
  });

  it("updates when stripe is later", () => {
    const r = maxPaidThroughDate("2026-08-01T00:00:00.000Z", sep1);
    expect(r.shouldUpdate).toBe(true);
  });

  it("skips identical", () => {
    const r = maxPaidThroughDate("2026-09-01T00:00:00.000Z", sep1);
    expect(r.shouldUpdate).toBe(false);
    expect(r.reason).toBe("Already up to date");
  });

  it("preserves existing later date", () => {
    const r = maxPaidThroughDate("2026-09-01T00:00:00.000Z", aug1);
    expect(r.shouldUpdate).toBe(false);
    expect(r.reason).toBe("Existing access date is later");
    expect(r.finalDate.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("flags invalid existing date", () => {
    const r = maxPaidThroughDate("not-a-date", sep1);
    expect(r.shouldUpdate).toBe(false);
    expect(r.invalidCurrent).toBe(true);
  });
});

describe("updateServiceAccessUntilForCustomer", () => {
  function mockAirtable(records: AirtableRecord[]) {
    const updateRecordsBatched = vi.fn(async (_t: string, updates: Array<{ id: string }>) =>
      updates.map((u) => ({ id: u.id, fields: {} }))
    );
    const listRecords = vi.fn(async () => records);
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
    };
  }

  const paidThrough = new Date("2026-09-01T00:00:00.000Z");

  it("returns no_airtable_member when empty", async () => {
    const at = mockAirtable([]);
    const r = await updateServiceAccessUntilForCustomer({
      airtable: at,
      stripeCustomerId: "cus_x",
      paidThrough,
      stripeInvoiceId: "in_1",
    });
    expect(r.status).toBe("no_airtable_member");
    expect(at.updateRecordsBatched).not.toHaveBeenCalled();
  });

  it("updates blank and batches", async () => {
    const at = mockAirtable([
      { id: "rec1", fields: { "Stripe Customer ID": "cus_x" } },
    ]);
    const r = await updateServiceAccessUntilForCustomer({
      airtable: at,
      stripeCustomerId: "cus_x",
      paidThrough,
      stripeInvoiceId: "in_1",
    });
    expect(r.airtableRecordsUpdated).toBe(1);
    const call = at.updateRecordsBatched.mock.calls[0][1] as Array<{
      id: string;
      fields: Record<string, unknown>;
    }>;
    expect(call[0].id).toBe("rec1");
    expect(call[0].fields.Payment).toBe("Paid");
    expect(call[0].fields.Membership).toBe("Active");
    expect(call[0].fields[SERVICE_ACCESS_FIELD]).toBe("2026-09-01T00:00:00.000Z");
    expect(call[0].fields["Stripe Customer ID"]).toBe("cus_x");
    expect(call[0].fields["Last invoice ID"]).toBe("in_1");
  });

  it("updates all duplicate records", async () => {
    const at = mockAirtable([
      { id: "rec1", fields: { "Stripe Customer ID": "cus_x" } },
      { id: "rec2", fields: { "Stripe Customer ID": "cus_x" } },
    ]);
    const r = await updateServiceAccessUntilForCustomer({
      airtable: at,
      stripeCustomerId: "cus_x",
      paidThrough,
      stripeInvoiceId: "in_1",
    });
    expect(r.duplicateAirtableRecords).toBe(true);
    expect(r.airtableRecordsUpdated).toBe(2);
    expect(at.updateRecordsBatched.mock.calls[0][1]).toHaveLength(2);
  });

  it("dryRun does not write", async () => {
    const at = mockAirtable([{ id: "rec1", fields: {} }]);
    const r = await updateServiceAccessUntilForCustomer({
      airtable: at,
      stripeCustomerId: "cus_x",
      paidThrough,
      stripeInvoiceId: "in_1",
      dryRun: true,
    });
    expect(r.status).toBe("updated");
    expect(r.airtableRecordsUpdated).toBe(0);
    expect(at.updateRecordsBatched).not.toHaveBeenCalled();
  });

  it("does not shorten access when existing is later but still marks Paid", async () => {
    const at = mockAirtable([
      {
        id: "rec1",
        fields: { [SERVICE_ACCESS_FIELD]: "2026-10-01T00:00:00.000Z" },
      },
    ]);
    const r = await updateServiceAccessUntilForCustomer({
      airtable: at,
      stripeCustomerId: "cus_x",
      paidThrough,
      stripeInvoiceId: "in_1",
    });
    expect(r.status).toBe("existing_later");
    expect(r.airtableRecordsUpdated).toBe(0);
    const call = at.updateRecordsBatched.mock.calls[0][1] as Array<{
      fields: Record<string, unknown>;
    }>;
    expect(call[0].fields.Payment).toBe("Paid");
    expect(call[0].fields.Membership).toBe("Active");
    expect(call[0].fields[SERVICE_ACCESS_FIELD]).toBeUndefined();
  });

  it("escapes customer id in formula", async () => {
    const at = mockAirtable([]);
    await updateServiceAccessUntilForCustomer({
      airtable: at,
      stripeCustomerId: 'cus_ab"c',
      paidThrough,
      stripeInvoiceId: "in_1",
    });
    const formula = at.listRecords.mock.calls[0][1].filterByFormula as string;
    expect(formula).toContain('cus_ab\\"c');
  });
});

describe("listPaidInvoicesForCustomer", () => {
  it("passes customer and status:paid to stripe.invoices.list", async () => {
    const list = vi.fn(async (params: Record<string, unknown>) => {
      expect(params.customer).toBe("cus_Target");
      expect(params.status).toBe("paid");
      expect(params.limit).toBe(100);
      return { data: [{ id: "in_1" }], has_more: false };
    });
    const invoices = await listPaidInvoicesForCustomer(
      { invoices: { list, listLineItems: vi.fn() } },
      "cus_Target"
    );
    expect(list).toHaveBeenCalledTimes(1);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].id).toBe("in_1");
  });

  it("does not list invoices for other customers", async () => {
    const list = vi.fn(async (params: { customer: string }) => {
      expect(params.customer).toBe("cus_Only");
      return { data: [], has_more: false };
    });
    await listPaidInvoicesForCustomer(
      { invoices: { list, listLineItems: vi.fn() } },
      "cus_Only"
    );
    expect(list.mock.calls.every((c) => c[0].customer === "cus_Only")).toBe(true);
  });

  it("paginates until has_more is false", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: "in_a" }, { id: "in_b" }],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: "in_c" }],
        has_more: false,
      });

    const invoices = await listPaidInvoicesForCustomer(
      { invoices: { list, listLineItems: vi.fn() } },
      "cus_page"
    );
    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[1][0].starting_after).toBe("in_b");
    expect(invoices.map((i) => i.id)).toEqual(["in_a", "in_b", "in_c"]);
  });

  it("throws on has_more with empty page (no infinite loop)", async () => {
    const list = vi.fn(async () => ({ data: [], has_more: true }));
    await expect(
      listPaidInvoicesForCustomer(
        { invoices: { list, listLineItems: vi.fn() } },
        "cus_bad"
      )
    ).rejects.toThrow(/has_more=true with empty data/);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid customer id before calling Stripe", async () => {
    const list = vi.fn();
    await expect(
      listPaidInvoicesForCustomer(
        { invoices: { list, listLineItems: vi.fn() } },
        "not_a_customer"
      )
    ).rejects.toThrow(/Invalid Stripe Customer ID/);
    expect(list).not.toHaveBeenCalled();
  });

  it("emits onPage progress callbacks", async () => {
    const onPage = vi.fn();
    const list = vi.fn(async () => ({ data: [{ id: "in_1" }], has_more: false }));
    await listPaidInvoicesForCustomer(
      { invoices: { list, listLineItems: vi.fn() } },
      "cus_p",
      { onPage }
    );
    expect(onPage).toHaveBeenCalledWith(1, 1, 1);
  });
});

describe("computeLatestMembershipPeriodEndForCustomer", () => {
  it("retrieves only the selected customer's invoices and lines", async () => {
    const periodEnd = 1_700_000_000;
    const list = vi.fn(async (params: { customer: string }) => {
      expect(params.customer).toBe("cus_A");
      return { data: [{ id: "in_1" }], has_more: false };
    });
    const listLineItems = vi.fn(async (invoiceId: string) => {
      expect(invoiceId).toBe("in_1");
      return {
        data: [
          {
            id: "il_1",
            period: { start: periodEnd - 10, end: periodEnd },
            pricing: {
              price_details: { price: "price_mem", product: "p" },
              type: "price_details",
              unit_amount_decimal: "1",
            },
          },
        ],
        has_more: false,
      };
    });

    const result = await computeLatestMembershipPeriodEndForCustomer(
      { invoices: { list, listLineItems } },
      "cus_A",
      new Set(["price_mem"])
    );
    expect(result.periodEndUnix).toBe(periodEnd);
    expect(result.invoicesInspected).toBe(1);
    expect(result.lineRequests).toBe(1);
    expect(result.qualifyingInvoices).toBe(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(listLineItems).toHaveBeenCalledTimes(1);
  });

  it("propagates Stripe list errors (does not convert to zero invoices)", async () => {
    const list = vi.fn(async () => {
      throw new Error("stripe timeout");
    });
    await expect(
      computeLatestMembershipPeriodEndForCustomer(
        { invoices: { list, listLineItems: vi.fn() } },
        "cus_err",
        new Set(["price_mem"])
      )
    ).rejects.toThrow("stripe timeout");
  });
});

describe("isValidStripeCustomerId", () => {
  it("accepts cus_ ids", () => {
    expect(isValidStripeCustomerId("cus_Ux7nKlU4lxpXUI")).toBe(true);
    expect(isValidStripeCustomerId("cus_abc")).toBe(true);
  });
  it("rejects others", () => {
    expect(isValidStripeCustomerId("")).toBe(false);
    expect(isValidStripeCustomerId("sub_123")).toBe(false);
  });
});

describe("parseBackfillArgs (via dynamic import of script logic)", () => {
  it("defaults to dry-run unless --apply", async () => {
    // Inline mirror of script defaults — keep in sync with parseBackfillArgs
    const { parseBackfillArgs } = await import(
      "../../../scripts/backfill-service-access-until"
    );
    expect(parseBackfillArgs([]).dryRun).toBe(true);
    expect(parseBackfillArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseBackfillArgs(["--apply"]).dryRun).toBe(false);
    expect(parseBackfillArgs(["--stripe-customer-id=cus_x"]).stripeCustomerId).toBe("cus_x");
  });
});
