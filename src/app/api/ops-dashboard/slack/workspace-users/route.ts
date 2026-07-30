import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import {
  filterWorkspaceUsers,
  scanWorkspaceUsers,
} from "@/lib/ops/workspace-users";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function GET(request: Request) {
  try {
    await requireOpsViewer();
    const url = new URL(request.url);
    const q = url.searchParams.get("q") || undefined;
    const channelId = url.searchParams.get("channelId") || undefined;
    const noConfiguredChannel = url.searchParams.get("noConfiguredChannel") === "1";
    const expiredOnly = url.searchParams.get("expiredOnly") === "1";
    const noAirtableMatch = url.searchParams.get("noAirtableMatch") === "1";
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(
      200,
      Math.max(10, parseInt(url.searchParams.get("pageSize") || "100", 10))
    );

    const scan = await scanWorkspaceUsers();
    const filtered = filterWorkspaceUsers(scan.users, {
      q,
      channelId,
      noConfiguredChannel,
      expiredOnly,
      noAirtableMatch,
    });
    const total = filtered.length;
    const start = (page - 1) * pageSize;

    return jsonOk({
      scannedAt: scan.scannedAt,
      total,
      page,
      pageSize,
      users: filtered.slice(start, start + pageSize),
      channelsChecked: scan.channelsChecked,
      warnings: scan.warnings,
      channelMembershipCalls: scan.channelMembershipCalls,
      reverseIndexBuilt: scan.reverseIndexBuilt,
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
