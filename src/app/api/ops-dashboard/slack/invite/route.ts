import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import {
  buildInviteQueue,
  detectSlackCommunityCapabilities,
} from "@/lib/ops/slack-community";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET() {
  try {
    await requireOpsViewer();
    const [queue, capabilities] = await Promise.all([
      buildInviteQueue(),
      detectSlackCommunityCapabilities(),
    ]);
    return jsonOk({
      scannedAt: queue.scannedAt,
      totalInvites: queue.inviteRows.length,
      totalChannelAdds: queue.channelAddRows.length,
      inviteRows: queue.inviteRows,
      channelAddRows: queue.channelAddRows,
      options: queue.options,
      capabilities,
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
