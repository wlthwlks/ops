import { NextRequest } from "next/server";
import { z } from "zod";
import { requireOpsAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { renderSampleEmail, unknownPlaceholders } from "@/lib/introduction/render-email";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";

const previewSchema = z.object({
  subject: z.string().min(1).max(500),
  bodyHtml: z.string().min(1).max(200_000),
});

/** Render a template draft against sample member data (no sending). */
export async function POST(request: NextRequest) {
  try {
    await requireOpsAdmin();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const body = await request.json().catch(() => null);
    const input = previewSchema.parse(body ?? {});
    const rendered = renderSampleEmail(input.subject, input.bodyHtml);
    return jsonOk({ ...rendered, unknownPlaceholders: unknownPlaceholders(input.subject, input.bodyHtml) });
  } catch (err) {
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
