import { describe, it, expect, afterEach } from "vitest";
import {
  aggregateNeonUsage,
  estimateCombinedCost,
  estimateFreePlanUsage,
  estimateProjectCost,
  FREE_PLAN_ALLOWANCES,
  getNeonRateCard,
  NEON_BILLING_HOURS_PER_MONTH,
  NEON_BYTES_PER_GB,
  resetNeonRateCardCache,
} from "@/lib/billing/neon-cost";
import type { NeonConsumptionPeriod } from "@/lib/integrations/neon";

function timeframe(
  start: string,
  end: string,
  metrics: Record<string, number>
): NeonConsumptionPeriod["consumption"][number] {
  return {
    timeframe_start: start,
    timeframe_end: end,
    metrics: Object.entries(metrics).map(([metric_name, value]) => ({ metric_name, value })),
  };
}

function periods(
  timeframes: NeonConsumptionPeriod["consumption"]
): NeonConsumptionPeriod[] {
  return [
    {
      period_id: "period-1",
      period_plan: "launch",
      period_start: timeframes[0]?.timeframe_start ?? "2026-09-01T00:00:00Z",
      consumption: timeframes,
    },
  ];
}

afterEach(() => {
  delete process.env.NEON_RATE_CARD_JSON;
  resetNeonRateCardCache();
});

describe("aggregateNeonUsage", () => {
  it("converts CU-seconds to CU-hours and byte-months to GB-months", () => {
    const usage = aggregateNeonUsage(
      periods([
        timeframe("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", {
          compute_unit_seconds: 3600,
          root_branch_bytes_month: 2 * NEON_BYTES_PER_GB,
          child_branch_bytes_month: NEON_BYTES_PER_GB,
          instant_restore_bytes_month: 0,
          snapshot_storage_bytes_month: 0,
          public_network_transfer_bytes: 3 * NEON_BYTES_PER_GB,
          private_network_transfer_bytes: 0,
        }),
      ])
    );

    expect(usage.computeCuHours).toBeCloseTo(1);
    expect(usage.rootStorageGbMonths).toBeCloseTo(2);
    expect(usage.childStorageGbMonths).toBeCloseTo(1);
    expect(usage.publicTransferGb).toBeCloseTo(3);
  });

  it("sums across multiple timeframes and periods", () => {
    const usage = aggregateNeonUsage(
      periods([
        timeframe("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", {
          compute_unit_seconds: 1800,
        }),
        timeframe("2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z", {
          compute_unit_seconds: 1800,
        }),
      ])
    );
    expect(usage.computeCuHours).toBeCloseTo(1);
  });
});

describe("estimateProjectCost", () => {
  it("applies Launch rates to usage", () => {
    const cost = estimateProjectCost(
      periods([
        timeframe("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", {
          compute_unit_seconds: 36000, // 10 CU-hours
          root_branch_bytes_month: 2 * NEON_BYTES_PER_GB,
        }),
      ]),
      "launch"
    );

    expect(cost.computeCost).toBeCloseTo(10 * 0.106);
    expect(cost.storageCost).toBeCloseTo(2 * 0.35);
    expect(cost.totalCost).toBeCloseTo(10 * 0.106 + 2 * 0.35);
  });

  it("charges public egress only beyond the 500 GB per-project allowance", () => {
    const below = estimateProjectCost(
      periods([
        timeframe("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", {
          public_network_transfer_bytes: 100 * NEON_BYTES_PER_GB,
        }),
      ]),
      "launch"
    );
    expect(below.billablePublicTransferGb).toBe(0);
    expect(below.transferCost).toBe(0);

    const above = estimateProjectCost(
      periods([
        timeframe("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", {
          public_network_transfer_bytes: 600 * NEON_BYTES_PER_GB,
        }),
      ]),
      "launch"
    );
    expect(above.billablePublicTransferGb).toBeCloseTo(100);
    expect(above.transferCost).toBeCloseTo(100 * 0.1);
  });

  it("subtracts the free branch allowance (9 child branches on Launch) per bucket", () => {
    const dailyHours = 24;
    const twelveChildBranches = 12 * dailyHours; // 12 child branches for one day
    const cost = estimateProjectCost(
      periods([
        timeframe("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", {
          extra_branches_month: twelveChildBranches,
        }),
      ]),
      "launch"
    );

    // Billable = (12 - 9) branches × 24h = 72 branch-hours → /744 branch-months
    const expectedMonths = (12 - 9) * dailyHours / NEON_BILLING_HOURS_PER_MONTH;
    expect(cost.billableExtraBranchMonths).toBeCloseTo(expectedMonths);
    expect(cost.extraBranchCost).toBeCloseTo(expectedMonths * 1.5);
  });

  it("never bills below-zero branch usage when under the allowance", () => {
    const cost = estimateProjectCost(
      periods([
        timeframe("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", {
          extra_branches_month: 24, // 1 child branch for one day
        }),
      ]),
      "launch"
    );
    expect(cost.billableExtraBranchMonths).toBe(0);
    expect(cost.extraBranchCost).toBe(0);
  });

  it("applies Scale compute rate and 24 free child branches", () => {
    const cost = estimateProjectCost(
      periods([
        timeframe("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", {
          compute_unit_seconds: 3600,
          extra_branches_month: 26 * 24, // 26 child branches for one day
        }),
      ]),
      "scale"
    );
    expect(cost.computeCost).toBeCloseTo(0.222);
    expect(cost.billableExtraBranchMonths).toBeCloseTo(
      (2 * 24) / NEON_BILLING_HOURS_PER_MONTH
    );
  });

  it("costs nothing on the free plan", () => {
    const cost = estimateProjectCost(
      periods([
        timeframe("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", {
          compute_unit_seconds: 360000,
          root_branch_bytes_month: 10 * NEON_BYTES_PER_GB,
          public_network_transfer_bytes: 1000 * NEON_BYTES_PER_GB,
        }),
      ]),
      "free"
    );
    expect(cost.totalCost).toBe(0);
  });
});

describe("estimateCombinedCost", () => {
  it("sums costs across projects (production + preview)", () => {
    const consumption = [
      {
        project_id: "prod",
        periods: periods([
          timeframe("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", {
            compute_unit_seconds: 36000,
          }),
        ]),
      },
      {
        project_id: "preview",
        periods: periods([
          timeframe("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", {
            compute_unit_seconds: 18000,
          }),
        ]),
      },
    ];

    const combined = estimateCombinedCost(consumption, "launch");
    expect(combined.usage.computeCuHours).toBeCloseTo(15);
    expect(combined.computeCost).toBeCloseTo(15 * 0.106);
    expect(combined.totalCost).toBeCloseTo(15 * 0.106);
  });
});

describe("estimateFreePlanUsage", () => {
  it("reads the project snapshot fields for free-plan projects", () => {
    const usage = estimateFreePlanUsage({
      project: {
        id: "p1",
        name: "p1",
        compute_time_seconds: 7200,
        data_storage_bytes_hour: NEON_BILLING_HOURS_PER_MONTH * 0.5 * NEON_BYTES_PER_GB,
        data_transfer_bytes: 2 * NEON_BYTES_PER_GB,
      },
    });
    expect(usage.computeCuHours).toBeCloseTo(2);
    expect(usage.storageGbMonths).toBeCloseTo(0.5);
    expect(usage.transferGb).toBeCloseTo(2);
    expect(FREE_PLAN_ALLOWANCES.computeCuHours).toBe(100);
  });
});

describe("getNeonRateCard", () => {
  it("defaults unknown plans to the Launch card", () => {
    const card = getNeonRateCard("enterprise");
    expect(card.computePerCuHour).toBeCloseTo(0.106);
  });

  it("applies NEON_RATE_CARD_JSON overrides", () => {
    process.env.NEON_RATE_CARD_JSON = JSON.stringify({
      launch: { computePerCuHour: 0.123 },
    });
    const card = getNeonRateCard("launch");
    expect(card.computePerCuHour).toBeCloseTo(0.123);
    expect(card.storagePerGbMonth).toBeCloseTo(0.35); // untouched defaults
  });
});
