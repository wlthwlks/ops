import { NextRequest } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/ops/cron-auth";
import { jsonOk } from "@/lib/ops/api-response";
import { runDeliveryWorkerTick } from "@/lib/introduction/delivery-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Delivery-queue worker tick. Processes a small chunk of frozen
 * introduction deliveries. Never sends anything unless INTRODUCTIONS_MODE
 * is live, and never touches runs whose delivery mode is simulation.
 */
export async function POST(request: NextRequest) {
  const unauthorized = rejectUnauthorizedCron(request);
  if (unauthorized) return unauthorized;

  const outcome = await runDeliveryWorkerTick();
  if (outcome.ok) {
    return jsonOk(outcome.response as unknown as Record<string, unknown>);
  }
  if (outcome.reason === "read_only") {
    return jsonOk({ processed: false, skipped: true, reason: "read_only", live: false });
  }
  return jsonOk(
    { processed: false, skipped: true, reason: outcome.reason, error: outcome.error },
    500
  );
}

export async function GET(request: NextRequest) {
  return POST(request);
}
