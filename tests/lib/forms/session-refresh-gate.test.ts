import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  deriveLoginSessionId,
  isProfileRefreshComplete,
  markProfileRefreshComplete,
  decodeJwtPayload,
} from "../../../widgets/shared/session-refresh-gate";

function b64url(obj: Record<string, unknown>): string {
  const json = JSON.stringify(obj);
  const b64 = Buffer.from(json, "utf8").toString("base64");
  return b64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `aaa.${b64url(payload)}.bbb`;
}

const store = new Map<string, string>();

describe("profile refresh session gate", () => {
  beforeEach(() => {
    store.clear();
    // Node test env has no sessionStorage
    (globalThis as unknown as { sessionStorage: Storage }).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => store.clear(),
      key: () => null,
      length: 0,
    };
  });

  afterEach(() => {
    // leave mock in place for isolation
  });

  it("derives session id from jti without storing token", () => {
    const token = fakeJwt({ sub: "mem_1", jti: "session-abc", iat: 100 });
    const id = deriveLoginSessionId({ accessToken: token, memberId: "mem_1" });
    expect(id).toBe("jti:session-abc");
    expect(id).not.toContain(token);
  });

  it("falls back to member + iat", () => {
    const token = fakeJwt({ sub: "mem_2", iat: 42 });
    expect(deriveLoginSessionId({ accessToken: token })).toBe("m:mem_2:iat:42");
  });

  it("remembers completion per member+session", () => {
    markProfileRefreshComplete({ memberId: "mem_a", sessionId: "s1" });
    expect(isProfileRefreshComplete({ memberId: "mem_a", sessionId: "s1" })).toBe(true);
    expect(isProfileRefreshComplete({ memberId: "mem_a", sessionId: "s2" })).toBe(false);
    expect(isProfileRefreshComplete({ memberId: "mem_b", sessionId: "s1" })).toBe(false);
  });

  it("decodes jwt payload safely", () => {
    const token = fakeJwt({ sub: "x", iat: 1 });
    expect(decodeJwtPayload(token)?.sub).toBe("x");
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
  });
});
