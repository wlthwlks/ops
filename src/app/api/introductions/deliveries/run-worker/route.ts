import { requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { runDeliveryWorkerTick } from "@/lib/introduction/delivery-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Admin-triggered delivery-worker tick (same code path as the 5-minute
 * cron). Sending email is a manual action: requires admin role and live
 * mode. Useful for local/testing environments where no cron runs.
 */
export async function POST() {
  try {
    await requireLiveAdmin("introductions/delivery-worker");
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const outcome = await runDeliveryWorkerTick();
    if (outcome.ok) {
      return jsonOk(outcome.response as unknown as Record<string, unknown>);
    }
    if (outcome.reason === "read_only") {
      return jsonOk({
        processed: false,
        skipped: true,
        reason: "read_only",
        live: false,
      });
    }
    return jsonOk(
      { processed: false, skipped: true, reason: outcome.reason, error: outcome.error },
      500
    );
  } catch (err) {
    return handleOpsApiError(err);
  }
}
