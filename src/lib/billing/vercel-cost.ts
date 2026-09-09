/**
 * Vercel billing analysis: aggregates the FOCUS charges feed and compares
 * consumption against the plan boundaries exposed in team billing
 * (invoiceItems thresholds) to decide when an upgrade is warranted.
 *
 * Vercel's public API reports:
 *  - charges: per-day/per-service rows with BilledCost + ConsumedQuantity
 *  - billing.invoiceItems: the plan's price list where `threshold > 0`
 *    marks the included quantity for that metered service
 *  - billing.includedAllocationUsd: dollar credit that absorbs small
 *    pay-as-you-go usage before real charges appear
 *
 * Boundaries are pure functions of (team billing, charges) — easy to test.
 */

import type {
  VercelBilling,
  VercelCharge,
  VercelInvoiceItem,
  VercelTeam,
} from "@/lib/integrations/vercel";

export type VercelFlag = {
  level: "info" | "warning" | "error";
  title: string;
  message: string;
};

export type VercelBoundary = {
  invoiceKey: string;
  serviceName: string;
  threshold: number;
  consumed: number;
  unit: string;
  /** Fraction of the included quantity used this period (0-1+). */
  pct: number;
  status: "ok" | "warning" | "exceeded";
};

/** Map invoiceItems keys to the ServiceName used in the charges feed. */
const DEFAULT_SERVICE_NAME_MAP: Record<string, string> = {
  fastDataTransfer: "Fast Data Transfer",
  fastOriginTransfer: "Fast Origin Transfer",
  edgeRequest: "Edge Requests",
  edgeMiddlewareInvocations: "Edge Middleware Invocations",
  edgeFunctionExecutionUnits: "Edge Function Execution Units",
  functionInvocation: "Function Invocations",
  functionDuration: "Function Duration",
  sandboxInvocations: "Sandbox Creations",
  sandboxDuration: "Sandbox Duration",
  observabilityEvent: "Observability Events",
  imageOptimizationCacheRead: "Image Optimization Cache Reads",
  imageOptimizationCacheWrite: "Image Optimization Cache Writes",
  imageOptimizationTransformation: "Image Optimization Transformation",
  isrRead: "ISR Reads",
  isrWrite: "ISR Writes",
  buildCpuMinutes: "Build CPU Minutes",
  blobDataTransfer: "Blob Data Transfer",
  blobTotalAvgSizeInBytes: "Blob Storage Size",
  analyticsUsage: "Web Analytics Events",
  webAnalyticsEvent: "Web Analytics Events",
  workflowEvents: "Workflow Events",
  workflowStorageWrite: "Workflow Storage Writes",
  deploymentStorage: "Deployment Storage",
  vcrStorage: "VCR Storage",
  snapshotStorage: "Snapshot Storage",
};

const WARNING_PCT = 0.8;

function getServiceNameMap(): Record<string, string> {
  const override = process.env.VERCEL_BOUNDARY_MAP_JSON;
  if (!override?.trim()) return DEFAULT_SERVICE_NAME_MAP;
  try {
    const parsed = JSON.parse(override) as Record<string, string>;
    return { ...DEFAULT_SERVICE_NAME_MAP, ...parsed };
  } catch {
    return DEFAULT_SERVICE_NAME_MAP;
  }
}

/** Invoice items that define an included-quantity boundary (threshold > 0). */
export function extractBoundaryItems(
  billing: VercelBilling | null | undefined
): Array<{ invoiceKey: string; item: VercelInvoiceItem }> {
  const items = billing?.invoiceItems ?? {};
  return Object.entries(items)
    .filter(([, item]) => !item.hidden && (item.threshold ?? 0) > 0)
    .map(([invoiceKey, item]) => ({ invoiceKey, item }));
}

function serviceNamesFor(invoiceKey: string, map: Record<string, string>): string[] {
  const mapped = map[invoiceKey];
  if (!mapped) return [];
  return [mapped];
}

/** Sum consumed quantity per service for a set of charges. */
export function consumedByService(charges: VercelCharge[]): Map<string, { total: number; unit: string }> {
  const out = new Map<string, { total: number; unit: string }>();
  for (const charge of charges) {
    if (charge.ChargeCategory !== "Usage") continue;
    const qty = charge.ConsumedQuantity ?? 0;
    if (qty <= 0) continue;
    const entry = out.get(charge.ServiceName) ?? { total: 0, unit: charge.ConsumedUnit ?? "" };
    entry.total += qty;
    if (!entry.unit && charge.ConsumedUnit) entry.unit = charge.ConsumedUnit;
    out.set(charge.ServiceName, entry);
  }
  return out;
}

/**
 * Compare per-service consumption (from charges) against the plan's included
 * quantities (invoiceItems thresholds). Only metered services that appear in
 * both are reported.
 */
export function buildVercelBoundaries(
  billing: VercelBilling | null | undefined,
  charges: VercelCharge[]
): VercelBoundary[] {
  const map = getServiceNameMap();
  const consumed = consumedByService(charges);
  const boundaries: VercelBoundary[] = [];

  for (const { invoiceKey, item } of extractBoundaryItems(billing)) {
    const threshold = item.threshold ?? 0;
    for (const serviceName of serviceNamesFor(invoiceKey, map)) {
      const entry = consumed.get(serviceName);
      if (!entry || entry.total <= 0) continue;
      const pct = entry.total / threshold;
      boundaries.push({
        invoiceKey,
        serviceName,
        threshold,
        consumed: entry.total,
        unit: entry.unit || "",
        pct,
        status: pct >= 1 ? "exceeded" : pct >= WARNING_PCT ? "warning" : "ok",
      });
    }
  }

  return boundaries.sort((a, b) => b.pct - a.pct);
}

// —— Charge aggregation ——

export type VercelCostSummary = {
  totalUsageCost: number;
  byService: Array<{ service: string; category: string; cost: number; quantity: number; unit: string | null }>;
  byDay: Array<{ date: string; cost: number }>;
  /** First day with any charge row (for day-range math). */
  firstDay: string | null;
  lastDay: string | null;
};

export function aggregateVercelCharges(charges: VercelCharge[]): VercelCostSummary {
  const usage = charges.filter((c) => c.ChargeCategory === "Usage");
  const byService = new Map<string, { category: string; cost: number; quantity: number; unit: string | null }>();
  const byDay = new Map<string, number>();

  for (const c of usage) {
    const entry = byService.get(c.ServiceName) ?? {
      category: c.ServiceCategory,
      cost: 0,
      quantity: 0,
      unit: c.ConsumedUnit,
    };
    entry.cost += c.BilledCost ?? 0;
    entry.quantity += c.ConsumedQuantity ?? 0;
    if (!entry.unit && c.ConsumedUnit) entry.unit = c.ConsumedUnit;
    byService.set(c.ServiceName, entry);

    const day = c.ChargePeriodStart.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + (c.BilledCost ?? 0));
  }

  const days = [...byDay.keys()].sort();
  return {
    totalUsageCost: usage.reduce((s, c) => s + (c.BilledCost ?? 0), 0),
    byService: [...byService.entries()]
      .map(([service, v]) => ({ service, ...v }))
      .sort((a, b) => b.cost - a.cost),
    byDay: [...byDay.entries()]
      .map(([date, cost]) => ({ date, cost }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    firstDay: days[0] ?? null,
    lastDay: days[days.length - 1] ?? null,
  };
}

// —— Subscription / plan cost info ——

export type VercelPlanInfo = {
  plan: string;
  planIteration: string | null;
  currency: string;
  status: string | null;
  billingEmail: string | null;
  subscriptionMonthlyUsd: number;
  includedAllocationUsd: number;
  additionalSeats: number;
  periodStart: string | null;
  periodEnd: string | null;
};

function priceFromCents(cents: number): number {
  return cents / 100;
}

export function describeVercelPlan(team: VercelTeam): VercelPlanInfo {
  const billing = team.billing;
  const invoiceItems = billing?.invoiceItems ?? {};

  const proPrice = invoiceItems.pro?.price ?? 0;
  const teamSeatsPrice = invoiceItems.teamSeats?.price ?? 0;
  const teamSeatsQty = invoiceItems.teamSeats
    ? (invoiceItems.teamSeats as unknown as { quantity?: number }).quantity ?? 0
    : 0;
  const includedAllocation = invoiceItems.includedAllocationUsd
    ? ((invoiceItems.includedAllocationUsd as unknown as { quantity?: number }).quantity ?? 0)
    : 0;

  return {
    plan: billing?.plan ?? "unknown",
    planIteration: billing?.planIteration ?? null,
    currency: billing?.currency ?? "usd",
    status: billing?.status ?? null,
    billingEmail: billing?.email ?? null,
    subscriptionMonthlyUsd: priceFromCents(proPrice),
    includedAllocationUsd: includedAllocation,
    additionalSeats: teamSeatsQty > 0 ? Math.round(teamSeatsQty * priceFromCents(teamSeatsPrice) * 100) / 100 : 0,
    periodStart: billing?.period?.start ? new Date(billing.period.start).toISOString() : null,
    periodEnd: billing?.period?.end ? new Date(billing.period.end).toISOString() : null,
  };
}

// —— Upgrade analysis (flags) ——

export type VercelAnalysis = {
  boundaries: VercelBoundary[];
  flags: VercelFlag[];
  projectedUsageCost: number | null;
  daysElapsed: number | null;
  daysTotal: number | null;
};

export function analyzeVercelBilling(args: {
  team: VercelTeam;
  charges: VercelCharge[];
  summary: VercelCostSummary;
}): VercelAnalysis {
  const { team, charges, summary } = args;
  const planInfo = describeVercelPlan(team);
  const boundaries = buildVercelBoundaries(team.billing, charges);
  const flags: VercelFlag[] = [];

  // Boundary statuses
  for (const b of boundaries) {
    if (b.status === "exceeded") {
      flags.push({
        level: "error",
        title: `${b.serviceName}: included allowance exceeded`,
        message: `Used ${b.consumed.toLocaleString("en-US", { maximumFractionDigits: 1 })} ${b.unit} vs ${b.threshold.toLocaleString("en-US")} included. Pay-as-you-go pricing now applies (${(b.pct * 100).toFixed(0)}% of allowance).`,
      });
    } else if (b.status === "warning") {
      flags.push({
        level: "warning",
        title: `${b.serviceName}: approaching included allowance`,
        message: `${(b.pct * 100).toFixed(0)}% of the ${b.threshold.toLocaleString("en-US")} ${b.unit} included allowance used this billing period.`,
      });
    }
  }

  // Real usage charges (beyond the included allocation credit)
  if (summary.totalUsageCost > 0.005) {
    flags.push({
      level: "warning",
      title: "Pay-as-you-go usage charges active",
      message: `$${summary.totalUsageCost.toFixed(2)} in usage charges so far this period (the ${planInfo.currency.toUpperCase()} ${planInfo.includedAllocationUsd} included allocation has been consumed). Review the service breakdown below.`,
    });
  }

  // Projection math
  let projectedUsageCost: number | null = null;
  let daysElapsed: number | null = null;
  let daysTotal: number | null = null;
  const periodStart = planInfo.periodStart ? new Date(planInfo.periodStart) : null;
  const periodEnd = planInfo.periodEnd ? new Date(planInfo.periodEnd) : null;
  if (periodStart && periodEnd && summary.totalUsageCost > 0.005) {
    const now = Date.now();
    const elapsedMs = Math.max(0, Math.min(now, periodEnd.getTime()) - periodStart.getTime());
    const totalMs = periodEnd.getTime() - periodStart.getTime();
    daysElapsed = elapsedMs / 86_400_000;
    daysTotal = totalMs / 86_400_000;
    if (daysElapsed > 0 && daysTotal > 0) {
      projectedUsageCost = summary.totalUsageCost * (daysTotal / daysElapsed);
      if (projectedUsageCost > 5) {
        flags.push({
          level: "info",
          title: "Usage-cost projection",
          message: `At the current burn rate, usage costs would reach ~$${projectedUsageCost.toFixed(2)} by the end of this billing period.`,
        });
      }
    }
  }

  // Plan-level advice
  if (planInfo.plan === "hobby") {
    flags.push({
      level: "info",
      title: "Hobby plan",
      message:
        "The Hobby plan is free with hard usage caps (100 GB bandwidth, 100 GB fast data transfer, 1M edge middleware invocations, 1M function executions per month). Deployments are blocked when caps are hit — upgrade to Pro before traffic spikes.",
    });
  }

  return { boundaries, flags, projectedUsageCost, daysElapsed, daysTotal };
}
