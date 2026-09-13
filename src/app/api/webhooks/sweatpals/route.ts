import { createHash, createHmac, timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  recordWebhookEvent,
  updateWebhookEventStatus,
  recordIntegrationError,
} from "@/lib/forms/webhooks/store";
import { handleSweatpalsEvent } from "@/lib/forms/sweatpals/webhook-handler";
import { FormsError } from "@/lib/forms/errors";

export const runtime = "nodejs";

function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature.trim(), "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const started = Date.now();
  const secret = process.env.SWEATPALS_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: "SWEATPALS_WEBHOOK_SECRET not configured" },
      { status: 500 }
    );
  }

  const signatureHeader = (
    process.env.SWEATPALS_WEBHOOK_SIGNATURE_HEADER || "x-sweatpals-signature"
  ).toLowerCase();
  const rawBody = await request.text();
  const signature = request.headers.get(signatureHeader);

  if (!signature) {
    await recordIntegrationError({
      code: "WEBHOOK_SIGNATURE_INVALID",
      source: "sweatpals",
      operation: "verify",
      title: "Missing signature header",
      message: `SweatPals webhook missing ${signatureHeader} header`,
    });
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  if (!verifySignature(rawBody, signature, secret)) {
    await recordIntegrationError({
      code: "WEBHOOK_SIGNATURE_INVALID",
      source: "sweatpals",
      operation: "verify",
      title: "Invalid SweatPals signature",
      message: "HMAC-SHA256 signature verification failed",
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch (err) {
    await recordIntegrationError({
      code: "WEBHOOK_PAYLOAD_INVALID",
      source: "sweatpals",
      operation: "parse",
      title: "Invalid SweatPals payload",
      message: err instanceof Error ? err.message : "JSON parse failed",
    });
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const eventType = String(payload.type || payload.event || payload.eventType || "unknown");
  const eventId = String(
    payload.id ||
      payload.eventId ||
      payload.event_id ||
      createHash("sha256").update(rawBody).digest("hex")
  );

  const stored = await recordWebhookEvent({
    provider: "sweatpals",
    providerEventId: eventId,
    eventType,
    signatureVerified: true,
    livemode: Boolean(payload.livemode ?? payload.liveMode),
    payload,
  });

  if (stored.duplicate && stored.status === "SUCCEEDED") {
    return NextResponse.json({
      received: true,
      duplicate: true,
      status: "SUCCEEDED",
    });
  }

  try {
    await updateWebhookEventStatus(stored.id, "PROCESSING");
    const result = await handleSweatpalsEvent({ eventType, payload });
    const status =
      result.status === "succeeded"
        ? "SUCCEEDED"
        : result.status === "failed"
          ? "FAILED"
          : result.status.startsWith("ignored")
            ? "IGNORED"
            : "SUCCEEDED";
    await updateWebhookEventStatus(stored.id, status, {
      processedAt: status === "SUCCEEDED" ? new Date() : null,
    });
    console.log(
      JSON.stringify({
        event: "sweatpals_webhook",
        eventType,
        status,
        reason: result.reason,
        durationMs: Date.now() - started,
      })
    );
    return NextResponse.json({
      received: true,
      processed: result.processed,
      status,
      reason: result.reason,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err instanceof FormsError ? err.code : "SWEATPALS_WEBHOOK_FAILED";
    const errorId = await recordIntegrationError({
      code,
      source: "sweatpals",
      operation: eventType,
      title: "SweatPals webhook processing failed",
      message: msg,
      retryable: true,
      webhookEventId: stored.id,
      stack: err instanceof Error ? err.stack : null,
    });
    await updateWebhookEventStatus(stored.id, "FAILED", { errorId });
    return NextResponse.json({ error: "Processing failed", errorId }, { status: 500 });
  }
}
