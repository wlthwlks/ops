/**
 * Fail-closed CRON authentication.
 * Missing/empty CRON_SECRET always rejects.
 */
import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

function safeEqualString(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/** True only when Authorization is exactly `Bearer <CRON_SECRET>` and secret is non-empty. */
export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) return false;

  const authorization = request.headers.get("authorization");
  if (!authorization) return false;

  const expected = `Bearer ${secret}`;
  return safeEqualString(authorization, expected);
}

/** 401 JSON body used by all cron routes. Never includes secrets. */
export function cronUnauthorizedResponse(): NextResponse {
  return NextResponse.json(
    { success: false, error: "Unauthorized", code: "CRON_UNAUTHORIZED" },
    { status: 401 }
  );
}

/**
 * If unauthorized, returns a 401 NextResponse; otherwise null (caller proceeds).
 */
export function rejectUnauthorizedCron(request: Request): NextResponse | null {
  if (isAuthorizedCronRequest(request)) return null;
  return cronUnauthorizedResponse();
}
