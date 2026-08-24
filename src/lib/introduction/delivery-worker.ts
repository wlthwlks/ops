import { db } from "@/db";
import { createResendClient } from "@/lib/integrations/resend";
import { getIntroductionsMode, IntroductionsConfigError } from "./runtime-mode";
import {
  processDeliveryBatch,
  resendGroupEmailSender,
  type DeliveryTickResult,
} from "./delivery-queue";

/**
 * Shared delivery-worker tick used by both the Vercel cron route and the
 * admin "Run delivery worker now" endpoint. Never sends anything unless
 * INTRODUCTIONS_MODE is live, and never touches simulation-mode jobs.
 */
export interface DeliveryWorkerTickResponse extends DeliveryTickResult {
  live: boolean;
  batchSize: number;
  logs: string[];
}

export type DeliveryWorkerOutcome =
  | { ok: true; response: DeliveryWorkerTickResponse }
  | {
      ok: false;
      reason: "invalid_mode" | "read_only" | "resend_not_configured";
      error?: string;
    };

export async function runDeliveryWorkerTick(
  log: (message: string) => void = () => {}
): Promise<DeliveryWorkerOutcome> {
  let live: boolean;
  try {
    live = getIntroductionsMode() === "live";
  } catch (err) {
    if (err instanceof IntroductionsConfigError) {
      console.log(JSON.stringify({ event: "intro_delivery_tick", skipped: true, reason: "invalid_mode", error: err.message }));
      return { ok: false, reason: "invalid_mode", error: err.message };
    }
    throw err;
  }
  if (!live) {
    console.log(JSON.stringify({ event: "intro_delivery_tick", skipped: true, reason: "read_only", live: false }));
    return { ok: false, reason: "read_only" };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(JSON.stringify({ event: "intro_delivery_tick", skipped: true, reason: "resend_not_configured" }));
    return { ok: false, reason: "resend_not_configured" };
  }

  const batchSizeRaw = Number.parseInt(
    process.env.INTRO_DELIVERY_WORKER_BATCH_SIZE ?? "20",
    10
  );
  const batchSize =
    Number.isFinite(batchSizeRaw) && batchSizeRaw > 0
      ? Math.min(batchSizeRaw, 100)
      : 20;

  const resend = createResendClient({ apiKey, fromEmail: "noreply@wlthwlks.com" });
  const logs: string[] = [];
  const result = await processDeliveryBatch(
    {
      db,
      sender: resendGroupEmailSender(resend),
      log: (message) => {
        logs.push(message);
        log(message);
      },
      live,
    },
    { batchSize }
  );

  // Structured log so Vercel runtime logs show exactly what every tick did.
  console.log(
    JSON.stringify({
      event: "intro_delivery_tick",
      live,
      batchSize,
      processed: result.processed,
      skipped: result.skipped,
      reason: result.reason,
      claimed: result.claimed,
      sent: result.sent,
      failed: result.failed,
      deferred: result.deferred,
      reclaimed: result.reclaimed,
      logs,
    })
  );

  return { ok: true, response: { live, batchSize, ...result, logs } };
}
