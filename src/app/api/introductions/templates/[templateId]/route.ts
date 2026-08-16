import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk, jsonError } from "@/lib/ops/api-response";
import {
  getEmailTemplate,
  getLatestTemplateVersion,
  listTemplateVersions,
} from "@/lib/introduction/templates";

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
    const template = await getEmailTemplate(db, templateId);
    if (!template) {
      return jsonError("TEMPLATE_NOT_FOUND", `Template ${templateId} not found`, 404);
    }
    const versions = await listTemplateVersions(db, templateId);
    const latestVersion = await getLatestTemplateVersion(db, templateId);
    return jsonOk({ template, versions, latestVersion });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
