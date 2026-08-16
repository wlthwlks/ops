import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError } from "zod";
import { NextRequest } from "next/server";

vi.mock("@/db", () => ({ db: {} }));

vi.mock("@/lib/introduction/runtime-mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/introduction/runtime-mode")>();
  return {
    ...actual,
    getIntroductionsMode: vi.fn().mockReturnValue("read_only"),
  };
});

vi.mock("@/lib/ops/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/auth")>();
  return {
    ...actual,
    requireOpsViewer: vi.fn().mockResolvedValue({
      userId: "user_viewer",
      role: "viewer",
      mode: "read_only",
    }),
    requireLiveAdmin: vi.fn().mockResolvedValue({
      userId: "user_admin",
      role: "admin",
      mode: "live",
    }),
  };
});

vi.mock("@/lib/introduction/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/introduction/settings")>();
  return {
    ...actual,
    getGlobalIntroductionConfig: vi.fn(),
    setGlobalIntroductionConfig: vi.fn(),
  };
});

const { GET, PUT } = await import("@/app/api/introductions/config/route");
const { requireLiveAdmin, requireOpsViewer, OpsAuthError } = await import("@/lib/ops/auth");
const { getIntroductionsMode } = await import("@/lib/introduction/runtime-mode");
const settings = await import("@/lib/introduction/settings");

const baseConfig = {
  senderFrom: "WLTH WLKS <noreply@wlthwlks.com>",
  canaryEmails: ["canary@wlthwlks.com"],
  providerTestEmails: [],
  defaultProfileId: null,
  defaultTemplateId: null,
};

function makeRequest(body: object): NextRequest {
  return new NextRequest("http://localhost/api/introductions/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/introductions/config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireOpsViewer).mockResolvedValue({
      userId: "user_viewer",
      role: "viewer",
      mode: "read_only",
    });
    vi.mocked(requireLiveAdmin).mockResolvedValue({
      userId: "user_admin",
      role: "admin",
      mode: "live",
    });
    vi.mocked(getIntroductionsMode).mockReturnValue("read_only");
    vi.mocked(settings.getGlobalIntroductionConfig).mockResolvedValue(baseConfig);
    vi.mocked(settings.setGlobalIntroductionConfig).mockResolvedValue(baseConfig);
  });

  it("GET returns mode, config and integration presence", async () => {
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.mode).toBe("read_only");
    expect(body.readOnly).toBe(true);
    expect(body.config.senderFrom).toContain("noreply@wlthwlks.com");
    expect(body.config.canaryEmails).toHaveLength(1);
    expect(typeof body.configured.resend).toBe("boolean");
    expect(typeof body.configured.resendWebhook).toBe("boolean");
    expect(typeof body.configured.openai).toBe("boolean");
    expect(typeof body.configured.pinecone).toBe("boolean");
    expect(typeof body.configured.googleMaps).toBe("boolean");
  });

  it("GET reports live when introductions mode is live", async () => {
    vi.mocked(getIntroductionsMode).mockReturnValue("live");
    const response = await GET();
    const body = await response.json();
    expect(body.mode).toBe("live");
    expect(body.readOnly).toBe(false);
    expect(body.live).toBe(true);
  });

  it("GET returns 500 when introductions mode is invalid", async () => {
    const { IntroductionsConfigError } = await import("@/lib/introduction/runtime-mode");
    vi.mocked(getIntroductionsMode).mockImplementation(() => {
      throw new IntroductionsConfigError("Unsupported INTRODUCTIONS_MODE");
    });    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
  });

  it("PUT requires a live admin", async () => {
    vi.mocked(requireLiveAdmin).mockRejectedValueOnce(
      new OpsAuthError("FORBIDDEN", "Admins only", 403)
    );
    const response = await PUT(makeRequest({ canaryEmails: ["a@wlthwlks.com"] }));
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.success).toBe(false);
    expect(settings.setGlobalIntroductionConfig).not.toHaveBeenCalled();
  });

  it("PUT persists the patch and returns the updated config", async () => {
    const patch = { canaryEmails: ["a@wlthwlks.com", "b@wlthwlks.com"] };
    vi.mocked(settings.setGlobalIntroductionConfig).mockResolvedValue({
      ...baseConfig,
      canaryEmails: patch.canaryEmails,
    });
    const response = await PUT(makeRequest(patch));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.config.canaryEmails).toEqual(patch.canaryEmails);
    expect(settings.setGlobalIntroductionConfig).toHaveBeenCalledWith(
      expect.anything(),
      patch
    );
  });

  it("PUT rejects an invalid email list with 400", async () => {
    vi.mocked(settings.setGlobalIntroductionConfig).mockRejectedValueOnce(
      new ZodError([{ code: "custom", path: ["canaryEmails", 0], message: "Invalid email" }])
    );
    const response = await PUT(makeRequest({ canaryEmails: ["nope"] }));
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("INVALID_PAYLOAD");
  });
});
