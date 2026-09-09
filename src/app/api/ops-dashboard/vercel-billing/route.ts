import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import {
  VercelApiError,
  getVercelCharges,
  resolveVercelBillingContext,
} from "@/lib/integrations/vercel";
import {
  aggregateVercelCharges,
  analyzeVercelBilling,
  describeVercelPlan,
} from "@/lib/billing/vercel-cost";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  try {
    await requireOpsViewer();

    const context = await resolveVercelBillingContext();
    const planInfo = describeVercelPlan(context.team);

    const now = new Date();
    const seriesFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    // Charges needed for boundary math start at the billing period, but never
    // before the 30-day chart window (keeps the payload bounded).
    const periodStart = context.periodStartMs
      ? new Date(context.periodStartMs)
      : seriesFrom;
    const from = periodStart.getTime() < seriesFrom.getTime() ? seriesFrom : periodStart;

    const charges = await getVercelCharges({
      teamId: context.team.id,
      from: from.toISOString(),
      to: now.toISOString(),
    });

    const summary = aggregateVercelCharges(charges);
    const analysis = analyzeVercelBilling({ team: context.team, charges, summary });

    return jsonOk({
      fetchedAt: now.toISOString(),
      team: {
        id: context.team.id,
        slug: context.team.slug,
        name: context.team.name,
      },
      plan: planInfo,
      summary,
      analysis,
      note:
        "Usage charges reflect pay-as-you-go usage beyond the plan's included allowances. The monthly subscription amount is shown separately in the plan card.",
    });
  } catch (err) {
    if (err instanceof Error && err.message === "VERCEL_TOKEN is not set") {
      return jsonError(
        "VERCEL_NOT_CONFIGURED",
        "VERCEL_TOKEN is not set. Create a token at vercel.com/account/tokens (full account or team scope) and add it to the environment.",
        503,
        { retryable: false }
      );
    }
    if (err instanceof VercelApiError) {
      return jsonError("VERCEL_API_ERROR", err.message, 502, { retryable: true });
    }
    return handleOpsApiError(err);
  }
}
