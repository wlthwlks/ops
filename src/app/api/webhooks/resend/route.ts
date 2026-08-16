import { NextRequest } from "next/server";
import { db } from "@/db";
import { jsonError, jsonOk } from "@/lib/ops/api-response";
import {
  applyResendWebhookEvent,
  verifyResendWebhook,
  type ResendWebhookEvent,
} from "@/lib/introduction/delivery-webhook";

export const dynamic = "force-dynamic";

/**
 * Verified Resend webhook endpoint for introduction delivery events.
 * Svix-signed; idempotent; out-of-order safe via provider timestamps.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return jsonError(
      "RESEND_WEBHOOK_NOT_CONFIGURED",
      "RESEND_WEBHOOK_SECRET is not configured",
      500
    );
  }

  let rawPayload: string;
  try {
    rawPayload = await request.text();
  } catch {
    return jsonError("WEBHOOK_BODY_UNREADABLE", "Could not read webhook body", 400);
  }

  const verification = verifyResendWebhook(
    rawPayload,
    {
      id: request.headers.get("svix-id"),
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
    },
    secret
  );
  if (!verification.ok) {
    return jsonError("WEBHOOK_INVALID_SIGNATURE", verification.error, 401);
  }

  let event: ResendWebhookEvent;
  try {
    event = JSON.parse(rawPayload) as ResendWebhookEvent;
  } catch {
    return jsonError("WEBHOOK_BODY_INVALID", "Webhook body is not valid JSON", 400);
  }

  try {
    const result = await applyResendWebhookEvent(db, event, {
      log: (message) => console.error(JSON.stringify({ event: "resend_webhook", message })),
    });
    return jsonOk({ processed: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "resend_webhook_error", error: message }));
    return jsonError("WEBHOOK_PROCESSING_FAILED", "Webhook processing failed", 500, {
      retryable: true,
    });
  }
}
