import { NextRequest } from "next/server";
import { db } from "@/db";
import { z } from "zod";
import { requireOpsViewer, requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk, jsonError } from "@/lib/ops/api-response";
import {
  getMatchingProfile,
  getLatestVersionForProfile,
  updateMatchingProfile,
  MatchingProfilesError,
} from "@/lib/introduction/profiles";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  isDefault: z.boolean().optional(),
});

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
    const profile = await getMatchingProfile(db, profileId);
    if (!profile) {
      return jsonError("MATCHING_PROFILE_NOT_FOUND", `Matching profile ${profileId} not found`, 404);
    }
    const latestVersion = await getLatestVersionForProfile(db, profileId);
    return jsonOk({ profile, latestVersion });
  } catch (err) {
    return handleOpsApiError(err);
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ profileId: string }> }
) {
  try {
    await requireLiveAdmin("introductions/profiles");
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { profileId } = await params;
    const body = await request.json().catch(() => null);
    const input = updateSchema.parse(body ?? {});
    const profile = await updateMatchingProfile(db, profileId, input);
    return jsonOk({ profile });
  } catch (err) {
    if (err instanceof MatchingProfilesError && err.code === "MATCHING_PROFILE_NOT_FOUND") {
      return jsonError(err.code, err.message, 404);
    }
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
