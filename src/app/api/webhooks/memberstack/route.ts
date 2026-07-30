import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import { recordWebhookEvent, updateWebhookEventStatus, recordIntegrationError } from "@/lib/forms/webhooks/store";
import { handleMemberstackEvent } from "@/lib/forms/webhooks/memberstack-handlers";
import { FormsError } from "@/lib/forms/errors";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const started = Date.now();
  const secret = process.env.MEMBERSTACK_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: "MEMBERSTACK_WEBHOOK_SECRET not configured" }, { status: 500 });
  }

  const rawBody = await request.text();
  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    await recordIntegrationError({
      code: "WEBHOOK_SIGNATURE_INVALID",
      source: "memberstack",
      operation: "verify",
      title: "Missing Svix headers",
      message: "Memberstack webhook missing signature headers",
    });
    return NextResponse.json({ error: "Missing signature headers" }, { status: 400 });
  }

  let payload: Record<string, unknown>;
  try {
    const wh = new Webhook(secret);
    payload = wh.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as Record<string, unknown>;
  } catch (err) {
    await recordIntegrationError({
      code: "WEBHOOK_SIGNATURE_INVALID",
      source: "memberstack",
      operation: "verify",
      title: "Invalid Memberstack signature",
      message: err instanceof Error ? err.message : "verify failed",
    });
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  const eventType = String(payload.type || payload.event || "unknown");
  const eventId = svixId;

  const stored = await recordWebhookEvent({
    provider: "memberstack",
    providerEventId: eventId,
    eventType,
    signatureVerified: true,
    livemode: Boolean(payload.livemode),
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
    const result = await handleMemberstackEvent({ eventType, payload });
    const status =
      result.status === "succeeded"
        ? "SUCCEEDED"
        : result.status === "pending_dependency"
          ? "PENDING_DEPENDENCY"
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
        event: "memberstack_webhook",
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
    const code = err instanceof FormsError ? err.code : "MEMBERSTACK_WEBHOOK_FAILED";
    const errorId = await recordIntegrationError({
      code,
      source: "memberstack",
      operation: eventType,
      title: "Memberstack webhook processing failed",
      message: msg,
      retryable: true,
      webhookEventId: stored.id,
      stack: err instanceof Error ? err.stack : null,
    });
    await updateWebhookEventStatus(stored.id, "FAILED", { errorId });
    return NextResponse.json({ error: "Processing failed", errorId }, { status: 500 });
  }
}
