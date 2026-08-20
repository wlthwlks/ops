import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import { buildCompare } from "@/lib/ops/slack-community";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    await requireOpsViewer();
    const body = await request.json();
    const airtableRecordId = String(body.airtableRecordId || "");
    const slackUserId = String(body.slackUserId || "");

    if (!airtableRecordId) {
      return jsonError("BAD_REQUEST", "airtableRecordId required", 400);
    }
    if (!slackUserId) {
      return jsonError("BAD_REQUEST", "slackUserId required", 400);
    }

    const compare = await buildCompare(airtableRecordId, slackUserId);
    return jsonOk(compare);
  } catch (err) {
    return handleOpsApiError(err);
  }
}
