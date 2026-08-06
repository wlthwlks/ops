import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isAuthorizedCronRequest,
  rejectUnauthorizedCron,
} from "@/lib/ops/cron-auth";

function req(authorization?: string | null): Request {
  const headers = new Headers();
  if (authorization !== undefined && authorization !== null) {
    headers.set("authorization", authorization);
  }
  return new Request("http://localhost/api/cron/test", { headers });
}

describe("isAuthorizedCronRequest", () => {
  const prev = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "test-cron-secret-value";
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  });

  it("accepts correct secret", () => {
    expect(isAuthorizedCronRequest(req("Bearer test-cron-secret-value"))).toBe(true);
  });

  it("rejects missing header", () => {
    expect(isAuthorizedCronRequest(req(null))).toBe(false);
    expect(isAuthorizedCronRequest(req(undefined))).toBe(false);
  });

  it("rejects wrong secret", () => {
    expect(isAuthorizedCronRequest(req("Bearer wrong"))).toBe(false);
  });

  it("rejects missing environment variable", () => {
    delete process.env.CRON_SECRET;
    expect(isAuthorizedCronRequest(req("Bearer test-cron-secret-value"))).toBe(false);
  });

  it("rejects empty environment variable", () => {
    process.env.CRON_SECRET = "   ";
    expect(isAuthorizedCronRequest(req("Bearer test-cron-secret-value"))).toBe(false);
    expect(isAuthorizedCronRequest(req("Bearer "))).toBe(false);
  });

  it("rejects Bearer undefined", () => {
    expect(isAuthorizedCronRequest(req("Bearer undefined"))).toBe(false);
  });

  it("rejects Bearer null", () => {
    expect(isAuthorizedCronRequest(req("Bearer null"))).toBe(false);
  });

  it("rejects malformed header", () => {
    expect(isAuthorizedCronRequest(req("test-cron-secret-value"))).toBe(false);
    expect(isAuthorizedCronRequest(req("Basic test-cron-secret-value"))).toBe(false);
  });

  it("rejectUnauthorizedCron returns 401 when unauthorized", async () => {
    const res = rejectUnauthorizedCron(req("Bearer wrong"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = await res!.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("CRON_UNAUTHORIZED");
  });

  it("rejectUnauthorizedCron returns null when authorized", () => {
    expect(rejectUnauthorizedCron(req("Bearer test-cron-secret-value"))).toBeNull();
  });
});
