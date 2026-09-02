/**
 * Neon cost estimation from consumption-history metrics.
 *
 * Neon's API returns raw usage, not dollar amounts. This module converts the
 * raw metrics into Neon's billing units and multiplies by the published plan
 * rates (see https://neon.com/docs/introduction/usage-calculations):
 *
 *   - CU-hours            = compute_unit_seconds / 3600
 *   - GB-months           = *_bytes_month / 1e9  (decimal gigabytes)
 *   - branch-months       = billable branch-hours / 744
 *   - public transfer     = GB per project beyond the included allowance
 *
 * Neon bills a fixed 744-hour month regardless of calendar length.
 * Rates are overridable per plan via NEON_RATE_CARD_JSON.
 */

import type {
  NeonConsumptionPeriod,
  NeonConsumptionProject,
  NeonProjectDetails,
} from "@/lib/integrations/neon";

export const NEON_BILLING_HOURS_PER_MONTH = 744;
export const NEON_BYTES_PER_GB = 1_000_000_000;

export type NeonRateCard = {
  computePerCuHour: number;
  storagePerGbMonth: number;
  instantRestorePerGbMonth: number;
  snapshotPerGbMonth: number;
  publicTransferPerGb: number;
  /** Included egress per project per month (GB). */
  publicTransferIncludedGb: number;
  privateTransferPerGb: number;
  extraBranchPerBranchMonth: number;
  /** Branches included per project (root + free child allowance). */
  includedBranchesPerProject: number;
};

/** Published Neon rates (https://neon.com/docs/introduction/plans). */
const DEFAULT_RATE_CARDS: Record<string, NeonRateCard> = {
  launch: {
    computePerCuHour: 0.106,
    storagePerGbMonth: 0.35,
    instantRestorePerGbMonth: 0.2,
    snapshotPerGbMonth: 0.09,
    publicTransferPerGb: 0.1,
    publicTransferIncludedGb: 500,
    privateTransferPerGb: 0,
    extraBranchPerBranchMonth: 1.5,
    includedBranchesPerProject: 10,
  },
  scale: {
    computePerCuHour: 0.222,
    storagePerGbMonth: 0.35,
    instantRestorePerGbMonth: 0.2,
    snapshotPerGbMonth: 0.09,
    publicTransferPerGb: 0.1,
    publicTransferIncludedGb: 500,
    privateTransferPerGb: 0.01,
    extraBranchPerBranchMonth: 1.5,
    includedBranchesPerProject: 25,
  },
  free: {
    computePerCuHour: 0,
    storagePerGbMonth: 0,
    instantRestorePerGbMonth: 0,
    snapshotPerGbMonth: 0,
    publicTransferPerGb: 0,
    publicTransferIncludedGb: Number.POSITIVE_INFINITY,
    privateTransferPerGb: 0,
    extraBranchPerBranchMonth: 0,
    includedBranchesPerProject: 10,
  },
};

function parseRateCardOverride(raw: string | undefined): Record<string, NeonRateCard> | null {
  if (!raw?.trim()) return null;
  const parsed = JSON.parse(raw) as Record<string, Partial<NeonRateCard>>;
  const merged: Record<string, NeonRateCard> = {};
  for (const [plan, overrides] of Object.entries(parsed)) {
    const base = DEFAULT_RATE_CARDS[plan] ?? DEFAULT_RATE_CARDS.launch;
    merged[plan] = { ...base, ...overrides };
  }
  return merged;
}

let _rateCardOverride: Record<string, NeonRateCard> | null | undefined;

/** Test helper — re-parse NEON_RATE_CARD_JSON on the next getNeonRateCards() call. */
export function resetNeonRateCardCache(): void {
  _rateCardOverride = undefined;
}

/** Rate cards with NEON_RATE_CARD_JSON applied (parsed once per process). */
export function getNeonRateCards(): Record<string, NeonRateCard> {
  if (_rateCardOverride === undefined) {
    try {
      _rateCardOverride = parseRateCardOverride(process.env.NEON_RATE_CARD_JSON);
    } catch {
      _rateCardOverride = null;
    }
  }
  return { ...DEFAULT_RATE_CARDS, ...(_rateCardOverride ?? {}) };
}

export function getNeonRateCard(plan: string | undefined): NeonRateCard {
  const cards = getNeonRateCards();
  const key = (plan ?? "").trim().toLowerCase() || "launch";
  return cards[key] ?? cards.launch;
}

// —— Usage aggregation ——

export type NeonUsageTotals = {
  computeCuHours: number;
  rootStorageGbMonths: number;
  childStorageGbMonths: number;
  instantRestoreGbMonths: number;
  snapshotGbMonths: number;
  publicTransferGb: number;
  privateTransferGb: number;
  extraBranchMonths: number;
};

function sumMetric(periods: NeonConsumptionPeriod[], metricName: string): number {
  let total = 0;
  for (const period of periods) {
    for (const timeframe of period.consumption) {
      for (const metric of timeframe.metrics) {
        if (metric.metric_name === metricName) total += metric.value;
      }
    }
  }
  return total;
}

function timeframeHours(timeframe: { timeframe_start: string; timeframe_end: string }): number {
  const start = new Date(timeframe.timeframe_start).getTime();
  const end = new Date(timeframe.timeframe_end).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return 0;
  return (end - start) / 3_600_000;
}

/**
 * Billable extra-branch usage. The metric counts all child branches, so each
 * timeframe's free allowance (includedBranches - 1, the root branch is always
 * included) × bucket hours is subtracted before converting to branch-months.
 */
function billableExtraBranchMonths(
  periods: NeonConsumptionPeriod[],
  includedBranchesPerProject: number
): number {
  const freeChildBranches = Math.max(0, includedBranchesPerProject - 1);
  let billableBranchHours = 0;
  for (const period of periods) {
    for (const timeframe of period.consumption) {
      const value =
        timeframe.metrics.find((m) => m.metric_name === "extra_branches_month")?.value ?? 0;
      const allowance = freeChildBranches * timeframeHours(timeframe);
      billableBranchHours += Math.max(0, value - allowance);
    }
  }
  return billableBranchHours / NEON_BILLING_HOURS_PER_MONTH;
}

export function aggregateNeonUsage(periods: NeonConsumptionPeriod[]): NeonUsageTotals {
  const rootStorageGbMonths = sumMetric(periods, "root_branch_bytes_month") / NEON_BYTES_PER_GB;
  const childStorageGbMonths =
    sumMetric(periods, "child_branch_bytes_month") / NEON_BYTES_PER_GB;
  return {
    computeCuHours: sumMetric(periods, "compute_unit_seconds") / 3600,
    rootStorageGbMonths,
    childStorageGbMonths,
    instantRestoreGbMonths:
      sumMetric(periods, "instant_restore_bytes_month") / NEON_BYTES_PER_GB,
    snapshotGbMonths:
      sumMetric(periods, "snapshot_storage_bytes_month") / NEON_BYTES_PER_GB,
    publicTransferGb:
      sumMetric(periods, "public_network_transfer_bytes") / NEON_BYTES_PER_GB,
    privateTransferGb:
      sumMetric(periods, "private_network_transfer_bytes") / NEON_BYTES_PER_GB,
    extraBranchMonths: 0, // branch allowance depends on the plan; computed in cost
  };
}

// —— Cost estimation ——

export type NeonProjectCost = NeonUsageTotals & {
  billablePublicTransferGb: number;
  billableExtraBranchMonths: number;
  computeCost: number;
  storageCost: number;
  instantRestoreCost: number;
  snapshotCost: number;
  extraBranchCost: number;
  transferCost: number;
  totalCost: number;
};

export function estimateProjectCost(
  periods: NeonConsumptionPeriod[],
  plan: string | undefined
): NeonProjectCost {
  const rates = getNeonRateCard(plan);
  const usage = aggregateNeonUsage(periods);
  const billableExtraBranch = billableExtraBranchMonths(
    periods,
    rates.includedBranchesPerProject
  );
  const billablePublicTransferGb = Math.max(
    0,
    usage.publicTransferGb - rates.publicTransferIncludedGb
  );

  const computeCost = usage.computeCuHours * rates.computePerCuHour;
  const storageCost =
    (usage.rootStorageGbMonths + usage.childStorageGbMonths) * rates.storagePerGbMonth;
  const instantRestoreCost = usage.instantRestoreGbMonths * rates.instantRestorePerGbMonth;
  const snapshotCost = usage.snapshotGbMonths * rates.snapshotPerGbMonth;
  const extraBranchCost = billableExtraBranch * rates.extraBranchPerBranchMonth;
  const transferCost =
    billablePublicTransferGb * rates.publicTransferPerGb +
    usage.privateTransferGb * rates.privateTransferPerGb;

  return {
    ...usage,
    extraBranchMonths: billableExtraBranch,
    billablePublicTransferGb,
    billableExtraBranchMonths: billableExtraBranch,
    computeCost,
    storageCost,
    instantRestoreCost,
    snapshotCost,
    extraBranchCost,
    transferCost,
    totalCost:
      computeCost + storageCost + instantRestoreCost + snapshotCost + extraBranchCost + transferCost,
  };
}

export type NeonCombinedCost = {
  usage: Omit<NeonUsageTotals, "extraBranchMonths"> & { extraBranchMonths: number };
  computeCost: number;
  storageCost: number;
  instantRestoreCost: number;
  snapshotCost: number;
  extraBranchCost: number;
  transferCost: number;
  totalCost: number;
};

export function estimateCombinedCost(
  consumption: NeonConsumptionProject[],
  plan: string | undefined
): NeonCombinedCost {
  const perProject = consumption.map((p) => estimateProjectCost(p.periods, plan));

  const usage = {
    computeCuHours: perProject.reduce((s, c) => s + c.computeCuHours, 0),
    rootStorageGbMonths: perProject.reduce((s, c) => s + c.rootStorageGbMonths, 0),
    childStorageGbMonths: perProject.reduce((s, c) => s + c.childStorageGbMonths, 0),
    instantRestoreGbMonths: perProject.reduce((s, c) => s + c.instantRestoreGbMonths, 0),
    snapshotGbMonths: perProject.reduce((s, c) => s + c.snapshotGbMonths, 0),
    publicTransferGb: perProject.reduce((s, c) => s + c.publicTransferGb, 0),
    privateTransferGb: perProject.reduce((s, c) => s + c.privateTransferGb, 0),
    extraBranchMonths: perProject.reduce((s, c) => s + c.billableExtraBranchMonths, 0),
  };

  const computeCost = perProject.reduce((s, c) => s + c.computeCost, 0);
  const storageCost = perProject.reduce((s, c) => s + c.storageCost, 0);
  const instantRestoreCost = perProject.reduce((s, c) => s + c.instantRestoreCost, 0);
  const snapshotCost = perProject.reduce((s, c) => s + c.snapshotCost, 0);
  const extraBranchCost = perProject.reduce((s, c) => s + c.extraBranchCost, 0);
  const transferCost = perProject.reduce((s, c) => s + c.transferCost, 0);

  return {
    usage,
    computeCost,
    storageCost,
    instantRestoreCost,
    snapshotCost,
    extraBranchCost,
    transferCost,
    totalCost:
      computeCost + storageCost + instantRestoreCost + snapshotCost + extraBranchCost + transferCost,
  };
}

// —— Free plan (no consumption history) ——

/**
 * Free-plan usage from the project snapshot. The consumption history API
 * requires a paid plan, so on `free` we read the project detail fields
 * instead. Cost is always $0; callers display usage vs allowances.
 */
export function estimateFreePlanUsage(details: NeonProjectDetails): {
  computeCuHours: number;
  storageGbMonths: number;
  transferGb: number;
} {
  const p = details.project;
  return {
    computeCuHours: (p.compute_time_seconds ?? 0) / 3600,
    storageGbMonths: (p.data_storage_bytes_hour ?? 0) / NEON_BILLING_HOURS_PER_MONTH / NEON_BYTES_PER_GB,
    transferGb: (p.data_transfer_bytes ?? 0) / NEON_BYTES_PER_GB,
  };
}

export const FREE_PLAN_ALLOWANCES = {
  computeCuHours: 100,
  storageGb: 0.5,
  transferGb: 5,
  branches: 10,
} as const;

export const NEON_RATE_CARD_HELP: Record<keyof NeonRateCard, string> = {
  computePerCuHour: "USD per Compute-Unit hour (1 CU ≈ 4 GB RAM).",
  storagePerGbMonth: "USD per GB-month of branch storage.",
  instantRestorePerGbMonth: "USD per GB-month of point-in-time-restore history.",
  snapshotPerGbMonth: "USD per GB-month of snapshot storage.",
  publicTransferPerGb: "USD per GB of public egress beyond the included allowance.",
  publicTransferIncludedGb: "Included public egress per project per month (GB).",
  privateTransferPerGb: "USD per GB of private-network transfer (Scale only).",
  extraBranchPerBranchMonth: "USD per branch-month beyond the included branch allowance.",
  includedBranchesPerProject: "Branches included per project (root branch + free allowance).",
};
