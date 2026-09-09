import { describe, it, expect, afterEach } from "vitest";
import {
  aggregateVercelCharges,
  analyzeVercelBilling,
  buildVercelBoundaries,
  describeVercelPlan,
} from "@/lib/billing/vercel-cost";
import type { VercelCharge, VercelTeam } from "@/lib/integrations/vercel";

function charge(partial: Partial<VercelCharge>): VercelCharge {
  return {
    ChargePeriodStart: "2026-08-23T00:00:00.000Z",
    ChargePeriodEnd: "2026-08-24T00:00:00.000Z",
    ChargeCategory: "Usage",
    BilledCost: 0,
    EffectiveCost: 0,
    ServiceName: "Edge Requests",
    ServiceCategory: "Compute",
    ConsumedQuantity: 0,
    ConsumedUnit: "Requests",
    ...partial,
  };
}

afterEach(() => {
  delete process.env.VERCEL_BOUNDARY_MAP_JSON;
});

describe("buildVercelBoundaries", () => {
  const billing = {
    plan: "pro",
    invoiceItems: {
      edgeRequest: { price: 0.0002, threshold: 10_000_000, hidden: false },
      fastDataTransfer: { price: 15, threshold: 1_000, hidden: false },
      functionInvocation: { price: 0.00006, threshold: 0, hidden: false },
      hiddenItem: { price: 1, threshold: 500, hidden: true },
    },
  };

  it("reports status from consumed vs threshold", () => {
    const charges = [
      charge({ ServiceName: "Edge Requests", ConsumedQuantity: 9_500_000, ConsumedUnit: "Requests" }),
      charge({ ServiceName: "Fast Data Transfer", ConsumedQuantity: 1_100, ConsumedUnit: "gigabyte" }),
      charge({ ServiceName: "Edge Requests", ConsumedQuantity: 9_500_000, ConsumedUnit: "Requests" }),
    ];
    const boundaries = buildVercelBoundaries(billing, charges);
    expect(boundaries).toHaveLength(2);
    const edge = boundaries.find((b) => b.serviceName === "Edge Requests");
    expect(edge).toBeDefined();
    expect(edge!.consumed).toBe(19_000_000);
    expect(edge!.pct).toBeCloseTo(1.9);
    expect(edge!.status).toBe("exceeded");
    const transfer = boundaries.find((b) => b.serviceName === "Fast Data Transfer");
    expect(transfer!.status).toBe("exceeded");
  });

  it("warns at 80% and ignores threshold-less and hidden items", () => {
    const charges = [
      charge({ ServiceName: "Edge Requests", ConsumedQuantity: 8_500_000, ConsumedUnit: "Requests" }),
      charge({ ServiceName: "Function Invocations", ConsumedQuantity: 500, ConsumedUnit: "Invocations" }),
    ];
    const boundaries = buildVercelBoundaries(billing, charges);
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0].status).toBe("warning");
    expect(boundaries[0].pct).toBeCloseTo(0.85);
  });

  it("omits services with no consumption", () => {
    const boundaries = buildVercelBoundaries(billing, [
      charge({ ServiceName: "Observability Events", ConsumedQuantity: 10, ConsumedUnit: "Events" }),
    ]);
    expect(boundaries).toHaveLength(0);
  });
});

describe("aggregateVercelCharges", () => {
  it("sums usage costs by service and day, ignoring non-usage charges", () => {
    const charges = [
      charge({ ServiceName: "Edge Requests", BilledCost: 1.5, ConsumedQuantity: 100 }),
      charge({ ServiceName: "Edge Requests", BilledCost: 2.5, ConsumedQuantity: 200 }),
      charge({ ServiceName: "Fast Data Transfer", BilledCost: 3, ConsumedQuantity: 20, ChargePeriodStart: "2026-08-24T00:00:00.000Z" }),
      charge({ ChargeCategory: "Purchase", ServiceName: "Pro", BilledCost: 20 }),
    ];
    const summary = aggregateVercelCharges(charges);
    expect(summary.totalUsageCost).toBeCloseTo(7);
    expect(summary.byService).toHaveLength(2);
    expect(summary.byService.find((s) => s.service === "Edge Requests")!.cost).toBeCloseTo(4);
    expect(summary.byService.find((s) => s.service === "Edge Requests")!.quantity).toBe(300);
    expect(summary.byDay).toEqual([
      { date: "2026-08-23", cost: 4 },
      { date: "2026-08-24", cost: 3 },
    ]);
  });
});

describe("analyzeVercelBilling", () => {
  const team: VercelTeam = {
    id: "team_1",
    slug: "test",
    name: "Test",
    billing: {
      plan: "pro",
      currency: "usd",
      period: {
        start: Date.UTC(2026, 7, 23),
        end: Date.UTC(2026, 8, 22),
      },
      invoiceItems: {
        pro: { price: 2000 },
        includedAllocationUsd: { price: 0, quantity: 20 } as never,
        edgeRequest: { price: 0.0002, threshold: 10_000_000 },
      },
    },
  };

  it("flags an exceeded boundary", () => {
    const charges = [
      charge({ ServiceName: "Edge Requests", BilledCost: 1, ConsumedQuantity: 11_000_000 }),
    ];
    const summary = aggregateVercelCharges(charges);
    const analysis = analyzeVercelBilling({ team, charges, summary });
    expect(analysis.boundaries[0].status).toBe("exceeded");
    expect(analysis.flags.some((f) => f.level === "error" && f.title.includes("Edge Requests"))).toBe(true);
  });

  it("flags active pay-as-you-go charges and projects month-end cost", () => {
    const charges = [
      charge({ ServiceName: "Edge Requests", BilledCost: 2, ConsumedQuantity: 0 }),
    ];
    const summary = aggregateVercelCharges(charges);
    const analysis = analyzeVercelBilling({ team, charges, summary });
    expect(analysis.flags.some((f) => f.title === "Pay-as-you-go usage charges active")).toBe(true);
    expect(analysis.projectedUsageCost).not.toBeNull();
    expect(analysis.projectedUsageCost!).toBeGreaterThan(2);
  });

  it("flags the hobby plan with upgrade guidance", () => {
    const hobby: VercelTeam = {
      id: "team_2",
      slug: "hobby",
      name: "Hobby",
      billing: { plan: "hobby" },
    };
    const analysis = analyzeVercelBilling({
      team: hobby,
      charges: [],
      summary: aggregateVercelCharges([]),
    });
    expect(analysis.flags.some((f) => f.title === "Hobby plan")).toBe(true);
  });
});

describe("describeVercelPlan", () => {
  it("converts cents to dollars and reads seats/allocation", () => {
    const team: VercelTeam = {
      id: "team_1",
      slug: "test",
      name: "Test",
      billing: {
        plan: "pro",
        planIteration: "plus",
        currency: "usd",
        email: "billing@example.com",
        period: { start: 1, end: 2 },
        invoiceItems: {
          pro: { price: 2000 },
          teamSeats: { price: 2000, quantity: 1 } as never,
          includedAllocationUsd: { price: 0, quantity: 20 } as never,
        },
      },
    };
    const plan = describeVercelPlan(team);
    expect(plan.subscriptionMonthlyUsd).toBe(20);
    expect(plan.includedAllocationUsd).toBe(20);
    expect(plan.additionalSeats).toBe(20);
    expect(plan.billingEmail).toBe("billing@example.com");
  });
});
