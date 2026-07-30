import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { scanChannelMemberships } from "@/lib/ops/channel-membership";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Explicit channel membership scan (read-only; works in read_only mode). */
export async function POST(request: Request) {
  try {
    await requireOpsViewer();
    let body: { activeOnlyFetch?: boolean } = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const result = await scanChannelMemberships({
      activeOnlyFetch: body.activeOnlyFetch !== false,
      concurrency: 3,
    });

    // Slim payload for list view; full lists stay for drawers
    return jsonOk({
      scannedAt: result.scannedAt,
      partial: result.partial,
      warnings: result.warnings,
      channels: result.channels,
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
