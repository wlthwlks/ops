import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireOpsViewer, requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import {
  createMatchingProfile,
  listMatchingProfiles,
} from "@/lib/introduction/profiles";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const profiles = await listMatchingProfiles(db);
    return jsonOk({ profiles });
  } catch (err) {
    return handleOpsApiError(err);
  }
}

export async function POST(request: NextRequest) {
  try {
    await requireLiveAdmin("introductions/profiles");
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const body = await request.json().catch(() => null);
    const profile = await createMatchingProfile(db, body ?? {});
    return jsonOk({ profile }, 201);
  } catch (err) {
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
