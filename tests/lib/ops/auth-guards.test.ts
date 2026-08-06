import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const authMock = vi.fn();

vi.mock("@clerk/nextjs/server", () => ({
  auth: () => authMock(),
}));

import {
  requireOpsViewer,
  requireOpsAdmin,
  requireLiveAdmin,
  OpsAuthError,
  resolveOpsRole,
} from "@/lib/ops/auth";

describe("ops auth guards", () => {
  const prevAdmin = process.env.OPS_ADMIN_USER_IDS;
  const prevViewer = process.env.OPS_VIEWER_USER_IDS;
  const prevMode = process.env.INTRODUCTIONS_MODE;
  const prevNode = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.OPS_ADMIN_USER_IDS = "user_admin";
    process.env.OPS_VIEWER_USER_IDS = "user_viewer";
    process.env.INTRODUCTIONS_MODE = "live";
    // Ensure allowlists are enforced (non-empty lists already fail closed for strangers)
    authMock.mockReset();
  });

  afterEach(() => {
    if (prevAdmin === undefined) delete process.env.OPS_ADMIN_USER_IDS;
    else process.env.OPS_ADMIN_USER_IDS = prevAdmin;
    if (prevViewer === undefined) delete process.env.OPS_VIEWER_USER_IDS;
    else process.env.OPS_VIEWER_USER_IDS = prevViewer;
    if (prevMode === undefined) delete process.env.INTRODUCTIONS_MODE;
    else process.env.INTRODUCTIONS_MODE = prevMode;
    void prevNode;
  });

  it("signed-out user cannot view", async () => {
    authMock.mockResolvedValue({ userId: null });
    await expect(requireOpsViewer()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });

  it("authenticated user not on allowlists is forbidden", async () => {
    authMock.mockResolvedValue({ userId: "user_stranger" });
    await expect(requireOpsViewer()).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
  });

  it("viewer can requireOpsViewer", async () => {
    authMock.mockResolvedValue({ userId: "user_viewer" });
    const ctx = await requireOpsViewer();
    expect(ctx.role).toBe("viewer");
  });

  it("viewer cannot requireOpsAdmin", async () => {
    authMock.mockResolvedValue({ userId: "user_viewer" });
    await expect(requireOpsAdmin()).rejects.toMatchObject({
      code: "FORBIDDEN_ADMIN",
      status: 403,
    });
  });

  it("admin in read_only cannot requireLiveAdmin", async () => {
    process.env.INTRODUCTIONS_MODE = "read_only";
    authMock.mockResolvedValue({ userId: "user_admin" });
    await expect(requireLiveAdmin("test-action")).rejects.toMatchObject({
      code: "MANUAL_ACTIONS_READ_ONLY",
      status: 403,
    });
  });

  it("admin in live mode can requireLiveAdmin", async () => {
    process.env.INTRODUCTIONS_MODE = "live";
    authMock.mockResolvedValue({ userId: "user_admin" });
    const ctx = await requireLiveAdmin("test-action");
    expect(ctx.role).toBe("admin");
    expect(ctx.mode).toBe("live");
  });

  it("resolveOpsRole maps allowlists", () => {
    expect(resolveOpsRole("user_admin")).toBe("admin");
    expect(resolveOpsRole("user_viewer")).toBe("viewer");
    expect(resolveOpsRole("user_x")).toBe("none");
    expect(resolveOpsRole(null)).toBe("none");
  });

  it("OpsAuthError carries status", () => {
    const e = new OpsAuthError("FORBIDDEN", "nope", 403, "read_only");
    expect(e.status).toBe(403);
    expect(e.mode).toBe("read_only");
  });
});
