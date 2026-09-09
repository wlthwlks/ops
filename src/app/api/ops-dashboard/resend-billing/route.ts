import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import {
  ResendApiError,
  getResendEmailMetrics,
  listResendDomains,
  type ResendMetricsRow,
} from "@/lib/integrations/resend-billing";
import {
  buildResendFlags,
  estimateResendMonthlyCost,
  getResendLimitsForPlan,
  getResendPlan,
  type ResendUsageSnapshot,
} from "@/lib/billing/resend-limits";

export const runtime = "nodejs";
export const maxDuration = 120;

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function monthStart(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function rowCount(rows: ResendMetricsRow[], metric: string): number {
  return rows.reduce((sum, row) => {
    const v = row[metric];
    return sum + (typeof v === "number" ? v : 0);
  }, 0);
}

export async function GET() {
  try {
    await requireOpsViewer();

    const plan = getResendPlan();
    const limits = getResendLimitsForPlan();
    const now = new Date();

    // Last 30 days with daily buckets for the chart + today's sends.
    const daily = await getResendEmailMetrics({
      startDate: toDateString(new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000)),
      endDate: toDateString(now),
      metrics: ["sent", "delivered", "bounced", "complained", "suppressed", "failed"],
      dimensions: ["period"],
      granularity: "daily",
    });

    // Month-to-date totals (single totals row).
    const monthly = await getResendEmailMetrics({
      startDate: toDateString(monthStart()),
      endDate: toDateString(now),
      metrics: ["sent", "delivered", "bounced", "complained"],
    });

    const domains = await listResendDomains();

    const series = daily.data
      .map((row) => ({
        date: String(row.period ?? "").slice(0, 10),
        sent: typeof row.sent === "number" ? row.sent : 0,
        delivered: typeof row.delivered === "number" ? row.delivered : 0,
        bounced: typeof row.bounced === "number" ? row.bounced : 0,
        complained: typeof row.complained === "number" ? row.complained : 0,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const today = toDateString(now);
    const sentToday = series.find((s) => s.date === today)?.sent ?? 0;
    const sentThisMonth = monthly.totals.sent ?? rowCount(daily.data, "sent");
    const delivered = monthly.totals.delivered ?? 0;
    const bounced = monthly.totals.bounced ?? 0;
    const complained = monthly.totals.complained ?? 0;

    const snapshot: ResendUsageSnapshot = {
      plan,
      limits,
      sentToday,
      sentThisMonth,
      bounceRatePct: sentThisMonth > 0 ? (bounced / sentThisMonth) * 100 : 0,
      complaintRatePct: delivered > 0 ? (complained / delivered) * 100 : 0,
      delivered,
      bounced,
      complained,
      domains: {
        total: domains.length,
        verified: domains.filter((d) => d.status === "verified").length,
      },
      estimatedMonthlyCostUsd: null,
    };
    snapshot.estimatedMonthlyCostUsd = estimateResendMonthlyCost(snapshot);

    return jsonOk({
      fetchedAt: now.toISOString(),
      plan,
      limits,
      totals: {
        sentToday,
        sentThisMonth,
        delivered,
        bounced,
        complained,
        bounceRatePct: snapshot.bounceRatePct,
        complaintRatePct: snapshot.complaintRatePct,
      },
      domains: snapshot.domains,
      estimatedMonthlyCostUsd: snapshot.estimatedMonthlyCostUsd,
      flags: buildResendFlags(snapshot),
      series,
      note:
        "Resend's API does not expose billing or plan data — limits come from RESEND_PLAN configuration and Resend's published pricing; usage is measured via the metrics endpoint.",
    });
  } catch (err) {
    if (err instanceof Error && err.message === "RESEND_API_KEY is not set") {
      return jsonError(
        "RESEND_NOT_CONFIGURED",
        "Neither RESEND_API_KEY nor RESEND_READ_API_KEY is set.",
        503,
        { retryable: false }
      );
    }
    if (err instanceof ResendApiError) {
      return jsonError("RESEND_API_ERROR", err.message, 502, { retryable: true });
    }
    return handleOpsApiError(err);
  }
}
