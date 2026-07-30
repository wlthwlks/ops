import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { db } from "@/db";
import { formAnalyticsEvents } from "@/db/schema";
import { desc, sql } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requireOpsViewer();
    let byType: Array<{ eventType: string; count: number }> = [];
    let recent: unknown[] = [];
    try {
      byType = await db
        .select({
          eventType: formAnalyticsEvents.eventType,
          count: sql<number>`count(*)::int`,
        })
        .from(formAnalyticsEvents)
        .groupBy(formAnalyticsEvents.eventType);

      recent = await db
        .select()
        .from(formAnalyticsEvents)
        .orderBy(desc(formAnalyticsEvents.createdAt))
        .limit(50);
    } catch {
      /* table missing */
    }

    const map = Object.fromEntries(byType.map((r) => [r.eventType, r.count]));
    const started = map.FORM_VIEWED || map.ACCOUNT_STARTED || 0;
    const completed = map.ONBOARDING_COMPLETED || 0;

    return jsonOk({
      kpis: {
        formViews: map.FORM_VIEWED || 0,
        accountStarted: map.ACCOUNT_STARTED || 0,
        accountCompleted: map.ACCOUNT_COMPLETED || 0,
        checkoutStarted: map.CHECKOUT_STARTED || 0,
        paymentReturned: map.PAYMENT_RETURNED || 0,
        onboardingCompleted: completed,
        completionRate:
          started > 0 ? Math.round((completed / started) * 1000) / 10 : null,
      },
      byType: map,
      recent,
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
