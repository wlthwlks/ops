/**
 * Simple in-memory sliding window rate limiter for public form APIs.
 * Suitable for single-instance / edge-adjacent protection; not a global cluster store.
 */

type Bucket = { timestamps: number[] };

const buckets = new Map<string, Bucket>();

export type RateLimitResult =
  | { ok: true; remaining: number }
  | { ok: false; remaining: 0; retryAfterSec: number };

export function rateLimit(input: {
  key: string;
  limit: number;
  windowMs: number;
  nowMs?: number;
}): RateLimitResult {
  const now = input.nowMs ?? Date.now();
  const windowStart = now - input.windowMs;
  let bucket = buckets.get(input.key);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(input.key, bucket);
  }
  bucket.timestamps = bucket.timestamps.filter((t) => t > windowStart);
  if (bucket.timestamps.length >= input.limit) {
    const oldest = bucket.timestamps[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + input.windowMs - now) / 1000));
    return { ok: false, remaining: 0, retryAfterSec };
  }
  bucket.timestamps.push(now);
  return { ok: true, remaining: input.limit - bucket.timestamps.length };
}

export function clientKeyFromRequest(request: Request, prefix: string): string {
  const xf = request.headers.get("x-forwarded-for");
  const ip = (xf?.split(",")[0] || request.headers.get("x-real-ip") || "unknown").trim();
  return `${prefix}:${ip}`;
}

/** Test helper */
export function _resetRateLimitBucketsForTests(): void {
  buckets.clear();
}

export function getPublicFormRateLimits() {
  return {
    writeLimit: Math.max(5, parseInt(process.env.FORMS_RATE_LIMIT_WRITE || "30", 10) || 30),
    writeWindowMs: Math.max(
      10_000,
      parseInt(process.env.FORMS_RATE_LIMIT_WRITE_WINDOW_MS || "60000", 10) || 60_000
    ),
    readLimit: Math.max(20, parseInt(process.env.FORMS_RATE_LIMIT_READ || "120", 10) || 120),
    readWindowMs: Math.max(
      10_000,
      parseInt(process.env.FORMS_RATE_LIMIT_READ_WINDOW_MS || "60000", 10) || 60_000
    ),
  };
}
