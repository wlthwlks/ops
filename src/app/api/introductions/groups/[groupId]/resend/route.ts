import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import {
  reQueueFailedGroupDeliveries,
  ResendGroupError,
} from "@/lib/introduction/resend-group";
import { runDeliveryWorkerTick } from "@/lib/introduction/delivery-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Retry a failed introduction group: refresh the failed members' emails
 * from Airtable by record id, re-queue their deliveries, and run a delivery
 * worker tick so the email goes out immediately. Requires admin + live mode
 * because this sends real email.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ groupId: string }> }
) {
  try {
    await requireLiveAdmin("introductions/group-resend");
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { groupId } = await params;
    const result = await reQueueFailedGroupDeliveries(db, groupId);

    const worker = await runDeliveryWorkerTick();
    const workerResponse =
      worker.ok
        ? worker.response
        : { processed: false, skipped: true, reason: worker.reason, error: worker.error };

    return jsonOk({
      ...result,
      worker: workerResponse,
    } as unknown as Record<string, unknown>);
  } catch (err) {
    if (err instanceof ResendGroupError) {
      const status = err.code === "GROUP_NOT_FOUND" ? 404 : 409;
      return jsonError(err.code, err.message, status);
    }
    return handleOpsApiError(err);
  }
}
