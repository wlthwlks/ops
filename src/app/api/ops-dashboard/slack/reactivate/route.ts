import { randomUUID } from "crypto";
import { requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import { executeWorkspaceReactivation } from "@/lib/ops/slack-community";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BULK = 25;

/**
 * Reactivate deactivated workspace accounts (admin.users.setRegular).
 * Requires SLACK_ADMIN_USER_TOKEN with admin.users:write (Enterprise Grid).
 * Server revalidates current access + deactivated identity per member.
 */
export async function POST(request: Request) {
  try {
    const admin = await requireLiveAdmin("slack/reactivate");
    const body = await request.json();
    const ids: string[] = Array.isArray(body.airtableRecordIds)
      ? body.airtableRecordIds.map(String)
      : body.airtableRecordId
        ? [String(body.airtableRecordId)]
        : [];

    if (ids.length === 0) {
      return jsonError("BAD_REQUEST", "airtableRecordId(s) required", 400);
    }
    if (ids.length > MAX_BULK) {
      return jsonError("BULK_LIMIT", `Maximum ${MAX_BULK} members per request`, 400);
    }

    const results = [];
    for (const id of ids) {
      const idempotencyKey =
        String(body.idempotencyKey || "") ||
        `workspace_reactivate:${id}:${new Date().toISOString().slice(0, 13)}`;
      const result = await executeWorkspaceReactivation({
        airtableRecordId: id,
        clerkUserId: admin.userId,
        runtimeMode: admin.mode,
        idempotencyKey:
          ids.length > 1
            ? `${idempotencyKey}:${randomUUID().slice(0, 8)}`
            : idempotencyKey,
      });
      results.push({ airtableRecordId: id, ...result });
    }

    const completed = results.filter((r) => r.status === "completed").length;
    const failed = results.filter((r) => r.status === "failed").length;

    return jsonOk({
      results,
      completed,
      failed,
      skipped: results.length - completed - failed,
      mode: admin.mode,
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
