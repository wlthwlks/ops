import { NextRequest } from "next/server";
import { db } from "@/db";
import { z } from "zod";
import { requireOpsViewer, requireOpsAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import {
  listTemplateVersions,
  saveEmailTemplateVersion,
  validateTemplateContent,
} from "@/lib/introduction/templates";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ templateId: string }> }
) {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { templateId } = await params;
    const versions = await listTemplateVersions(db, templateId);
    return jsonOk({ versions });
  } catch (err) {
    return handleOpsApiError(err);
  }
}

const saveSchema = z.object({
  subject: z.string().min(1).max(500),
  bodyHtml: z.string().min(1).max(200_000),
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
    const input = saveSchema.parse(body ?? {});
    const version = await saveEmailTemplateVersion(db, templateId, input);
    const validation = validateTemplateContent(version.subject, version.bodyHtml);
    return jsonOk({ version, validation }, 201);
  } catch (err) {
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
