import { describe, it, expect, vi } from "vitest";
import type { AirtableClient } from "@/lib/integrations/airtable";
import {
  parseHistoricalRepairArgs,
  repairPayingStripeCustomer,
  nameFromStripeCustomer,
} from "@/lib/billing/historical-stripe-member-repair";
import { STRIPE_CUSTOMER_ID_FIELD, SERVICE_ACCESS_FIELD } from "@/lib/billing/service-access-sync";

describe("parseHistoricalRepairArgs", () => {
  it("defaults to dry-run", () => {
    const a = parseHistoricalRepairArgs([]);
    expect(a.dryRun).toBe(true);
    expect(a.canLink).toBe(false);
    expect(a.canCreate).toBe(false);
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

describe("nameFromStripeCustomer", () => {
  it("prefers customer name", () => {
    expect(
      nameFromStripeCustomer({ name: "Ada Lovelace", id: "cus_1" } as never, "a@b.com")
    ).toBe("Ada Lovelace");
  });

  it("falls back to email local part", () => {
    expect(nameFromStripeCustomer({ id: "cus_1" } as never, "ada@b.com")).toBe("ada");
  });
});

describe("repairPayingStripeCustomer", () => {
  const membershipPriceIds = new Set(["price_mem"]);
  const periodEnd = Math.floor(new Date("2026-09-01T00:00:00.000Z").getTime() / 1000);

  function mockStripe() {
    return {
      customers: {
        list: vi.fn(),
        retrieve: vi.fn(),
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
    const stripe = mockStripe();
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
            Name: "Pay User",
          }),
        }),
      ])
    );
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
