import { NextResponse } from "next/server";
import { OpsAuthError } from "@/lib/ops/auth";
import {
  IntroductionsConfigError,
  IntroductionsReadOnlyError,
} from "@/lib/introduction/runtime-mode";
import { AirtableSchemaMismatchError } from "@/lib/ops/airtable-fields";

export type ApiErrorBody = {
  success: false;
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  mode?: string;
};

export function jsonOk<T extends Record<string, unknown>>(data: T, status = 200) {
  return NextResponse.json({ success: true, ...data }, { status });
}

export function jsonError(
  code: string,
  message: string,
  status: number,
  extra?: { details?: unknown; retryable?: boolean; mode?: string }
) {
  const body: ApiErrorBody = {
    success: false,
    code,
    message,
    ...extra,
  };
  return NextResponse.json(body, { status });
}

/** Map known domain errors to structured API responses. Never leak secrets. */
export function handleOpsApiError(err: unknown) {
  if (err instanceof OpsAuthError) {
    return jsonError(err.code, err.message, err.status, {
      mode: err.mode,
      retryable: false,
    });
  }
  if (err instanceof IntroductionsReadOnlyError) {
    return jsonError(err.code, err.message, 403, {
      mode: "read_only",
      retryable: false,
    });
  }
  if (err instanceof IntroductionsConfigError) {
    return jsonError(err.code, err.message, 500, { retryable: false });
  }
  if (err instanceof AirtableSchemaMismatchError) {
    return jsonError(err.code, err.message, 422, {
      retryable: false,
      details: { table: err.table, field: err.field },
    });
  }
  const msg = err instanceof Error ? err.message : "Unexpected error";
  // Strip anything that looks like a secret token fragment
  const safe = msg
    .replace(/sk_live_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/sk_test_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/whsec_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/pat[A-Za-z0-9._-]{10,}/g, "[redacted]")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted]");
  console.error(JSON.stringify({ event: "ops_api_error", error: safe }));
  return jsonError("INTERNAL_ERROR", safe, 500, { retryable: true });
}
