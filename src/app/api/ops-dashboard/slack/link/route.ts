import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import {
  buildLinkQueue,
  detectSlackCommunityCapabilities,
} from "@/lib/ops/slack-community";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  try {
    await requireOpsViewer();
    const [queue, capabilities] = await Promise.all([
      buildLinkQueue(),
      detectSlackCommunityCapabilities(),
    ]);
    return jsonOk({
      scannedAt: queue.scannedAt,
      total: queue.rows.length,
      rows: queue.rows,
      memberCount: queue.memberCount,
      slackUserCount: queue.slackUserCount,
      options: queue.options,
      capabilities,
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
