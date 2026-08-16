import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireOpsViewer, requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk, jsonError } from "@/lib/ops/api-response";
import {
  getCitySettings,
  upsertCitySettings,
  resolveEffectiveCitySettings,
  IntroductionSettingsError,
} from "@/lib/introduction/settings";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ cityCode: string }> }
) {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { cityCode } = await params;
    const city = await getCitySettings(db, cityCode);
    const effective = await resolveEffectiveCitySettings(db, cityCode);
    return jsonOk({ city, effective });
  } catch (err) {
    if (err instanceof IntroductionSettingsError) {
      return jsonError(err.code, err.message, 422);
    }
    return handleOpsApiError(err);
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ cityCode: string }> }
) {
  try {
    await requireLiveAdmin("introductions/cities");
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { cityCode } = await params;
    const body = await request.json().catch(() => null);
    const city = await upsertCitySettings(db, cityCode, body ?? {});
    const effective = await resolveEffectiveCitySettings(db, cityCode);
    return jsonOk({ city, effective });
  } catch (err) {
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
