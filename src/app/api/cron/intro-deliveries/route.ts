import { NextRequest } from "next/server";
import { db } from "@/db";
import { rejectUnauthorizedCron } from "@/lib/ops/cron-auth";
import { getIntroductionsMode, IntroductionsConfigError } from "@/lib/introduction/runtime-mode";
import { jsonOk } from "@/lib/ops/api-response";
import { createResendClient } from "@/lib/integrations/resend";
import {
  processDeliveryBatch,
  resendGroupEmailSender,
} from "@/lib/introduction/delivery-queue";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Delivery-queue worker tick. Processes a small chunk of frozen
 * introduction deliveries. Never sends anything unless INTRODUCTIONS_MODE
 * is live, and never touches runs whose delivery mode is simulation.
 */
export async function POST(request: NextRequest) {
  const unauthorized = rejectUnauthorizedCron(request);
  if (unauthorized) return unauthorized;

  let live: boolean;
  try {
    live = getIntroductionsMode() === "live";
  } catch (err) {
    if (err instanceof IntroductionsConfigError) {
      return jsonOk({ processed: false, skipped: true, reason: "invalid_mode", error: err.message }, 500);
    }
    throw err;
  }

  if (!live) {
    return jsonOk({ processed: false, skipped: true, reason: "read_only", live: false });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return jsonOk(
      { processed: false, skipped: true, reason: "resend_not_configured" },
      500
    );
  }

  const batchSizeRaw = Number.parseInt(process.env.INTRO_DELIVERY_WORKER_BATCH_SIZE ?? "20", 10);
  const batchSize = Number.isFinite(batchSizeRaw) && batchSizeRaw > 0 ? Math.min(batchSizeRaw, 100) : 20;

  const resend = createResendClient({ apiKey, fromEmail: "noreply@wlthwlks.com" });
  const logs: string[] = [];
  const result = await processDeliveryBatch(
    {
      db,
      sender: resendGroupEmailSender(resend),
      log: (message) => logs.push(message),
      live,
    },
    { batchSize }
  );

  return jsonOk({ live, batchSize, ...result, logs });
}

export async function GET(request: NextRequest) {
  return POST(request);
}
