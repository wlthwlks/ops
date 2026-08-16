import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireOpsViewer, requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import {
  createMatchingProfileVersion,
  listVersionsForProfile,
  matchingWeightsSchema,
  matchingConstraintsSchema,
} from "@/lib/introduction/profiles";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";
import { z } from "zod";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ profileId: string }> }
) {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { profileId } = await params;
    const versions = await listVersionsForProfile(db, profileId);
    return jsonOk({ versions });
  } catch (err) {
    return handleOpsApiError(err);
  }
}

const versionInputSchema = z.object({
  weights: matchingWeightsSchema.optional(),
  constraints: matchingConstraintsSchema.optional(),
  createdBy: z.string().min(1).max(120).optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ profileId: string }> }
) {
  try {
    await requireLiveAdmin("introductions/profiles/versions");
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { profileId } = await params;
    const body = await request.json().catch(() => null);
    const input = versionInputSchema.parse(body ?? {});
    const version = await createMatchingProfileVersion(db, { profileId, ...input });
    return jsonOk({ version }, 201);
  } catch (err) {
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
