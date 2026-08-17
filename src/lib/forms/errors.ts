export const INTEGRATION_ERROR_CODES = [
  "WEBHOOK_SIGNATURE_INVALID",
  "WEBHOOK_PAYLOAD_INVALID",
  "WEBHOOK_DUPLICATE",
  "WEBHOOK_EVENT_UNSUPPORTED",
  "WEBHOOK_EVENT_OUT_OF_ORDER",
  "MEMBERSTACK_MEMBER_NOT_FOUND",
  "MEMBERSTACK_API_FAILED",
  "MEMBERSTACK_EMAIL_CONFLICT",
  "MEMBERSTACK_WEBHOOK_FAILED",
  "STRIPE_MEMBER_NOT_FOUND",
  "STRIPE_CUSTOMER_CONFLICT",
  "STRIPE_SUBSCRIPTION_NOT_FOUND",
  "STRIPE_API_FAILED",
  "STRIPE_PAYMENT_FAILED",
  "STRIPE_RECONCILIATION_PENDING",
  "STRIPE_MEMBERSHIP_PRICE_IDS_MISSING",
  "AIRTABLE_AUTH_FAILED",
  "AIRTABLE_PERMISSION_DENIED",
  "AIRTABLE_BASE_OR_TABLE_NOT_FOUND",
  "AIRTABLE_RATE_LIMITED",
  "AIRTABLE_MEMBER_NOT_FOUND",
  "AIRTABLE_DUPLICATE_MEMBER",
  "AIRTABLE_VALIDATION_FAILED",
  "AIRTABLE_WRITE_FAILED",
  "MEMBER_IDENTITY_CONFLICT",
  "SIGNUP_CREATION_IN_PROGRESS",
  "SIGNUP_CREATION_FAILED",
  "PROFILE_VALIDATION_FAILED",
  "REFERENCE_VALUE_INVALID",
  "CITY_COUNTRY_MISMATCH",
  "TIMEZONE_MISMATCH",
  "ONBOARDING_STATE_INVALID",
  "KLAVIYO_SYNC_FAILED",
  "INTERNAL_UNEXPECTED_ERROR",
] as const;

export type IntegrationErrorCode = (typeof INTEGRATION_ERROR_CODES)[number];

export function redactSecrets(value: string): string {
  return value
    .replace(/sk_live_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/sk_test_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/whsec_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/pat[A-Za-z0-9._-]{10,}/g, "[redacted]")
    .replace(/pk_[A-Za-z0-9]{10,}/g, "[redacted]")
    .replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/"password"\s*:\s*"[^"]*"/gi, '"password":"[redacted]"');
}

export function sanitizePayload(input: unknown): unknown {
  if (input == null) return input;
  if (typeof input === "string") return redactSecrets(input).slice(0, 8000);
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) return input.slice(0, 50).map(sanitizePayload);
  const out: Record<string, unknown> = {};
  const obj = input as Record<string, unknown>;
  const blocked = new Set([
    "password",
    "authorization",
    "card",
    "cvc",
    "number",
    "secret",
    "client_secret",
  ]);
  for (const [k, v] of Object.entries(obj)) {
    if (blocked.has(k.toLowerCase())) {
      out[k] = "[redacted]";
      continue;
    }
    out[k] = sanitizePayload(v);
  }
  return out;
}

export class FormsError extends Error {
  readonly code: IntegrationErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    code: IntegrationErrorCode,
    message: string,
    opts?: { status?: number; retryable?: boolean; details?: unknown }
  ) {
    super(redactSecrets(message));
    this.name = "FormsError";
    this.code = code;
    this.status = opts?.status ?? 400;
    this.retryable = opts?.retryable ?? false;
    this.details = opts?.details;
  }
}
