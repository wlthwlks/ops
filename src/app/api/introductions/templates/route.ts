import { NextRequest } from "next/server";
import { db } from "@/db";
import { z } from "zod";
import { requireOpsViewer, requireOpsAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import {
  createEmailTemplate,
  listEmailTemplates,
} from "@/lib/introduction/templates";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const templates = await listEmailTemplates(db);
    return jsonOk({ templates });
  } catch (err) {
    return handleOpsApiError(err);
  }
}

export const templateContentSchema = z.object({
  name: z.string().trim().min(1).max(120),
  subject: z.string().min(1).max(500),
  bodyHtml: z.string().min(1).max(200_000),
});

export async function POST(request: NextRequest) {
  try {
    await requireOpsAdmin();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const body = await request.json().catch(() => null);
    const input = templateContentSchema.parse(body ?? {});
    const result = await createEmailTemplate(db, input);
    return jsonOk(result, 201);
  } catch (err) {
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
