import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireOpsAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { publishEmailTemplate } from "@/lib/introduction/templates";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  try {
    await requireOpsAdmin();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { templateId } = await params;
    const version = await publishEmailTemplate(db, templateId);
    return jsonOk({ version });
  } catch (err) {
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
