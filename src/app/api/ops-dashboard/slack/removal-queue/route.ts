import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { buildRemovalQueue } from "@/lib/ops/slack-removal";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  try {
    await requireOpsViewer();
    const result = await buildRemovalQueue();
    return jsonOk({
      scannedAt: result.scannedAt,
      total: result.rows.length,
      rows: result.rows,
      capabilities: result.capabilities,
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
