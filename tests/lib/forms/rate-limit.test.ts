import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetRateLimitBucketsForTests,
  rateLimit,
} from "@/lib/forms/rate-limit";

describe("rateLimit", () => {
  beforeEach(() => {
    _resetRateLimitBucketsForTests();
  });

  it("allows up to limit then blocks", () => {
    const key = "t:1";
    const windowMs = 60_000;
    for (let i = 0; i < 3; i++) {
      const r = rateLimit({ key, limit: 3, windowMs, nowMs: 1000 + i });
      expect(r.ok).toBe(true);
    }
    const blocked = rateLimit({ key, limit: 3, windowMs, nowMs: 1005 });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("resets after window", () => {
    const key = "t:2";
    expect(rateLimit({ key, limit: 1, windowMs: 1000, nowMs: 0 }).ok).toBe(true);
    expect(rateLimit({ key, limit: 1, windowMs: 1000, nowMs: 10 }).ok).toBe(false);
    expect(rateLimit({ key, limit: 1, windowMs: 1000, nowMs: 1001 }).ok).toBe(true);
  });
});
