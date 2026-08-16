import { NextRequest } from "next/server";
import { db } from "@/db";
import {
  getIntroductionsMode,
  IntroductionsConfigError,
} from "@/lib/introduction/runtime-mode";
import { requireOpsViewer, requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import {
  getGlobalIntroductionConfig,
  setGlobalIntroductionConfig,
} from "@/lib/introduction/settings";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    let mode: string;
    try {
      mode = getIntroductionsMode();
    } catch (err) {
      if (err instanceof IntroductionsConfigError) return handleOpsApiError(err);
      throw err;
    }
    const live = mode === "live";
    const config = await getGlobalIntroductionConfig(db);
    return jsonOk({
      mode,
      readOnly: !live,
      live,
      config,
      configured: {
        resend: Boolean(process.env.RESEND_API_KEY),
        resendWebhook: Boolean(process.env.RESEND_WEBHOOK_SECRET),
        openai: Boolean(process.env.OPENAI_API_KEY),
        pinecone: Boolean(process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX_NAME),
        googleMaps: Boolean(process.env.GOOGLE_MAPS_API_KEY),
      },
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}

export async function PUT(request: NextRequest) {
  try {
    await requireLiveAdmin("introductions/config");
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const body = await request.json().catch(() => null);
    const config = await setGlobalIntroductionConfig(db, body ?? {});
    return jsonOk({ config });
  } catch (err) {
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
