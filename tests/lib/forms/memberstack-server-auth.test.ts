import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("verifyMemberstackToken", () => {
  const prevKey = process.env.MEMBERSTACK_SECRET_KEY;
  const prevAllow = process.env.ALLOW_MEMBERSTACK_TEST_AUTH;
  const prevNode = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
    process.env.MEMBERSTACK_SECRET_KEY = "sk_sb_test";
    delete process.env.ALLOW_MEMBERSTACK_TEST_AUTH;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("verify-token")) {
          const body = JSON.parse(String(init?.body || "{}"));
          if (body.token === "bad") {
            return {
              ok: false,
              status: 400,
              json: async () => ({ code: "INVALID_TOKEN", message: "Invalid token" }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                id: "mem_verified",
                type: "member",
                iat: 1,
                exp: Math.floor(Date.now() / 1000) + 3600,
                aud: "app_x",
                iss: "https://api.memberstack.com",
              },
            }),
          };
        }
        if (u.includes("/members/mem_verified")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: {
                id: "mem_verified",
                auth: { email: "v@example.com" },
                customFields: { "first-name": "Ver", "last-name": "Ified" },
              },
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevKey === undefined) delete process.env.MEMBERSTACK_SECRET_KEY;
    else process.env.MEMBERSTACK_SECRET_KEY = prevKey;
    if (prevAllow === undefined) delete process.env.ALLOW_MEMBERSTACK_TEST_AUTH;
    else process.env.ALLOW_MEMBERSTACK_TEST_AUTH = prevAllow;
    process.env.NODE_ENV = prevNode;
  });

  it("verifies token then loads member profile", async () => {
    const { verifyMemberstackToken } = await import("@/lib/forms/memberstack/auth");
    const m = await verifyMemberstackToken("good.jwt.token");
    expect(m.id).toBe("mem_verified");
    expect(m.email).toBe("v@example.com");
    expect(m.firstName).toBe("Ver");
    expect(fetch).toHaveBeenCalled();
    const verifyCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find((c) =>
      String(c[0]).includes("verify-token")
    );
    expect(verifyCall).toBeTruthy();
    const body = JSON.parse(String(verifyCall![1].body));
    expect(body.token).toBe("good.jwt.token");
  });

  it("returns 401 for invalid token", async () => {
    const { verifyMemberstackToken } = await import("@/lib/forms/memberstack/auth");
    await expect(verifyMemberstackToken("bad")).rejects.toMatchObject({
      status: 401,
    });
  });

  it("returns 401 for missing token", async () => {
    const { verifyMemberstackToken } = await import("@/lib/forms/memberstack/auth");
    await expect(verifyMemberstackToken("")).rejects.toMatchObject({ status: 401 });
  });

  it("returns 500 when secret missing", async () => {
    delete process.env.MEMBERSTACK_SECRET_KEY;
    const { verifyMemberstackToken } = await import("@/lib/forms/memberstack/auth");
    await expect(verifyMemberstackToken("x.y.z")).rejects.toMatchObject({ status: 500 });
  });
});
