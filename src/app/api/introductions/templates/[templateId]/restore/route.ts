import { NextRequest } from "next/server";
import { db } from "@/db";
import { z } from "zod";
import { requireOpsAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { restoreEmailTemplateVersion } from "@/lib/introduction/templates";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";

const restoreSchema = z.object({
  versionId: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  try {
    await requireOpsAdmin();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { templateId } = await params;
    const body = await request.json().catch(() => null);
    const input = restoreSchema.parse(body ?? {});
    const version = await restoreEmailTemplateVersion(db, templateId, input.versionId);
    return jsonOk({ version });
  } catch (err) {
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
