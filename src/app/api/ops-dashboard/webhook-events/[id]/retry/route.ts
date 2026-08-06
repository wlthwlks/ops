import { requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { reprocessWebhookEvent } from "@/lib/forms/webhooks/reprocess";
import { FormsError } from "@/lib/forms/errors";
import { jsonError } from "@/lib/ops/api-response";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    await requireLiveAdmin("webhook-events/retry");
    const { id } = await ctx.params;
    if (!id) return jsonError("BAD_REQUEST", "id required", 400);
    const result = await reprocessWebhookEvent(id);
    return jsonOk(result);
  } catch (err) {
    if (err instanceof FormsError) {
      return jsonError(err.code, err.message, err.status, {
        details: err.details,
        retryable: err.retryable,
      });
    }
    return handleOpsApiError(err);
  }
}
