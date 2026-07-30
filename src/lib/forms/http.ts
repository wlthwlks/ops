import { NextResponse } from "next/server";
import { withCors } from "@/lib/forms/cors";
import {
  clientKeyFromRequest,
  getPublicFormRateLimits,
  rateLimit,
} from "@/lib/forms/rate-limit";
import { FormsError } from "@/lib/forms/errors";

export function enforcePublicWriteRateLimit(
  request: Request,
  prefix: string
): NextResponse | null {
  const { writeLimit, writeWindowMs } = getPublicFormRateLimits();
  const result = rateLimit({
    key: clientKeyFromRequest(request, prefix),
    limit: writeLimit,
    windowMs: writeWindowMs,
  });
  if (result.ok) return null;
  return withCors(
    NextResponse.json(
      {
        success: false,
        code: "RATE_LIMITED",
        message: "Too many requests. Please try again shortly.",
        retryable: true,
        retryAfterSec: result.retryAfterSec,
      },
      {
        status: 429,
        headers: { "Retry-After": String(result.retryAfterSec) },
      }
    ),
    request
  );
}

export function formsErrorResponse(request: Request, err: unknown): NextResponse {
  if (err instanceof FormsError) {
    return withCors(
      NextResponse.json(
        {
          success: false,
          code: err.code,
          message: err.message,
          details: err.details,
          retryable: err.retryable,
        },
        { status: err.status }
      ),
      request
    );
  }
  return withCors(
    NextResponse.json(
      {
        success: false,
        code: "INTERNAL_UNEXPECTED_ERROR",
        message: err instanceof Error ? err.message : "Unexpected error",
      },
      { status: 500 }
    ),
    request
  );
}
