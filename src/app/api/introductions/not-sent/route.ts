import { db } from "@/db";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { listNotSentItems } from "@/lib/introduction/not-sent";

export const dynamic = "force-dynamic";

/**
 * Lists introduction emails that were never sent: blocked/failed runs
 * (no groups produced), failed groups, and deliveries with terminal
 * failure statuses. Used by the "Not Sent" tab of the Match History page.
 */
export async function GET() {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const result = await listNotSentItems(db);
    return jsonOk(result as unknown as Record<string, unknown>);
  } catch (err) {
    return handleOpsApiError(err);
  }
}
