import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import {
  NeonApiError,
  getNeonConsumption,
  getNeonProject,
  resolveNeonBillingContext,
  type NeonConsumptionPeriod,
} from "@/lib/integrations/neon";
import {
  estimateCombinedCost,
  estimateFreePlanUsage,
  estimateProjectCost,
  getNeonRateCard,
  type NeonProjectCost,
} from "@/lib/billing/neon-cost";

export const runtime = "nodejs";
export const maxDuration = 120;

const GB = 1_000_000_000;

function toIso(date: Date): string {
  return date.toISOString();
}

function openPeriod(periods: NeonConsumptionPeriod[]): NeonConsumptionPeriod | null {
  const sorted = [...periods].sort((a, b) =>
    a.period_start.localeCompare(b.period_start)
  );
  for (let i = sorted.length - 1; i >= 0; i--) {
    const period = sorted[i];
    if (!period.period_end || new Date(period.period_end).getTime() > Date.now()) {
      return period;
    }
  }
  return sorted.length > 0 ? sorted[sorted.length - 1] : null;
}

function currentPeriodTimeframes(periods: NeonConsumptionPeriod[]): {
  period: NeonConsumptionPeriod | null;
  timeframes: NeonConsumptionPeriod["consumption"];
} {
  const period = openPeriod(periods);
  if (!period) return { period: null, timeframes: [] };
  return { period, timeframes: period.consumption };
}

/** Daily per-project series for the 30-day chart, cost estimated at plan rates. */
function buildDailySeries(
  consumption: Awaited<ReturnType<typeof getNeonConsumption>>,
  envLabelByProject: Map<string, string>,
  plan: string
) {
  const rates = getNeonRateCard(plan);
  const rows: Array<{
    date: string;
    projectId: string;
    envLabel: string;
    computeCuHours: number;
    storageGbMonths: number;
    estimatedCost: number;
  }> = [];

  for (const project of consumption) {
    const envLabel = envLabelByProject.get(project.project_id) ?? "Unknown";
    for (const period of project.periods) {
      for (const tf of period.consumption) {
        const metrics = new Map(tf.metrics.map((m) => [m.metric_name, m.value]));
        const computeCuHours = (metrics.get("compute_unit_seconds") ?? 0) / 3600;
        const storageGbMonths =
          ((metrics.get("root_branch_bytes_month") ?? 0) +
            (metrics.get("child_branch_bytes_month") ?? 0) +
            (metrics.get("instant_restore_bytes_month") ?? 0) +
            (metrics.get("snapshot_storage_bytes_month") ?? 0)) /
          GB;
        const estimatedCost =
          computeCuHours * rates.computePerCuHour +
          storageGbMonths * rates.storagePerGbMonth +
          ((metrics.get("instant_restore_bytes_month") ?? 0) / GB) *
            rates.instantRestorePerGbMonth +
          ((metrics.get("snapshot_storage_bytes_month") ?? 0) / GB) *
            rates.snapshotPerGbMonth;
        rows.push({
          date: tf.timeframe_start.slice(0, 10),
          projectId: project.project_id,
          envLabel,
          computeCuHours,
          storageGbMonths,
          estimatedCost,
        });
      }
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.projectId.localeCompare(b.projectId));
  return rows;
}

function latestHourlyUsage(
  consumption: Awaited<ReturnType<typeof getNeonConsumption>>,
  projectId: string
) {
  const project = consumption.find((p) => p.project_id === projectId);
  if (!project) return null;
  let computeCuHours = 0;
  let storageGbMonths = 0;
  for (const period of project.periods) {
    for (const tf of period.consumption) {
      for (const m of tf.metrics) {
        if (m.metric_name === "compute_unit_seconds") computeCuHours += m.value / 3600;
        if (m.metric_name === "root_branch_bytes_month") storageGbMonths += m.value / GB;
        if (m.metric_name === "child_branch_bytes_month") storageGbMonths += m.value / GB;
      }
    }
  }
  return { computeCuHours, storageGbMonths };
}

export async function GET() {
  try {
    await requireOpsViewer();

    const context = await resolveNeonBillingContext();
    const plan = (context.org.plan ?? "launch").trim().toLowerCase();
    const rates = getNeonRateCard(plan);
    const envLabelByProject = new Map(
      context.projects.map((p) => [p.id, p.envLabel])
    );

    const now = new Date();
    const fromDaily = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fromHourly = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const projectIds = context.projects.map((p) => p.id);

    const isPaidPlan = plan !== "free";

    const daily = isPaidPlan
      ? await getNeonConsumption({
          orgId: context.org.id,
          projectIds,
          from: toIso(fromDaily),
          to: toIso(now),
          granularity: "daily",
        })
      : [];
    const hourly = isPaidPlan
      ? await getNeonConsumption({
          orgId: context.org.id,
          projectIds,
          from: toIso(fromHourly),
          to: toIso(now),
          granularity: "hourly",
        })
      : [];

    const details = await Promise.all(context.projects.map((p) => getNeonProject(p.id)));

    const projectCosts = new Map<string, NeonProjectCost | null>();
    const currentPeriods = new Map<string, { start?: string; end?: string }>();
    // Consumption limited to the open (current) billing period, per project —
    // the same slices feed both the per-project costs and the combined total.
    const currentConsumption: Array<{
      project_id: string;
      periods: NeonConsumptionPeriod[];
    }> = [];
    if (isPaidPlan) {
      for (const project of daily) {
        const { period, timeframes } = currentPeriodTimeframes(project.periods);
        const openPeriod: NeonConsumptionPeriod = {
          ...(period ?? { period_id: "", period_plan: plan, period_start: toIso(fromDaily) }),
          consumption: timeframes,
        };
        currentConsumption.push({ project_id: project.project_id, periods: [openPeriod] });
        projectCosts.set(project.project_id, estimateProjectCost([openPeriod], plan));
        if (period) {
          currentPeriods.set(project.project_id, {
            start: period.period_start,
            end: period.period_end,
          });
        }
      }
    }

    const projects = context.projects.map((p) => {
      const detail = details.find((d) => d.project.id === p.id);
      const cost = projectCosts.get(p.id) ?? null;
      const freeUsage = !isPaidPlan && detail ? estimateFreePlanUsage(detail) : null;
      return {
        id: p.id,
        name: p.name,
        envLabel: p.envLabel,
        isCurrentEnv: p.isCurrentEnv,
        regionId: detail?.project.region_id ?? null,
        pgVersion: detail?.project.pg_version ?? null,
        createdAt: detail?.project.created_at ?? null,
        cost,
        freeUsage,
        latestHourUsage: latestHourlyUsage(hourly, p.id),
        currentPeriod: currentPeriods.get(p.id) ?? null,
      };
    });

    const totals = isPaidPlan
      ? estimateCombinedCost(currentConsumption, plan)
      : {
          usage: {
            computeCuHours: 0,
            rootStorageGbMonths: 0,
            childStorageGbMonths: 0,
            instantRestoreGbMonths: 0,
            snapshotGbMonths: 0,
            publicTransferGb: 0,
            privateTransferGb: 0,
            extraBranchMonths: 0,
          },
          computeCost: 0,
          storageCost: 0,
          instantRestoreCost: 0,
          snapshotCost: 0,
          extraBranchCost: 0,
          transferCost: 0,
          totalCost: 0,
        };

    return jsonOk({
      fetchedAt: toIso(now),
      org: { id: context.org.id, name: context.org.name, plan },
      plan,
      environment: context.projects.find((p) => p.isCurrentEnv)?.envLabel ?? null,
      rates: { ...rates, plan },
      projects,
      totals,
      series: buildDailySeries(daily, envLabelByProject, plan),
      freePlanNote: isPaidPlan
        ? null
        : "Neon's Free plan has no dollar cost. Usage shown against the free allowances.",
    });
  } catch (err) {
    if (err instanceof Error && err.message === "NEON_API_KEY is not set") {
      return jsonError(
        "NEON_NOT_CONFIGURED",
        "NEON_API_KEY is not set. Add an org-scoped API key from the Neon Console (Account settings → API keys) to enable the billing tab.",
        503,
        { retryable: false }
      );
    }
    if (err instanceof NeonApiError) {
      return jsonError("NEON_API_ERROR", err.message, 502, { retryable: true });
    }
    return handleOpsApiError(err);
  }
}
