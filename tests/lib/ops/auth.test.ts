import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveOpsRole,
  assertManualActionsLive,
  OpsAuthError,
} from "@/lib/ops/auth";

describe("resolveOpsRole", () => {
  const prevAdmin = process.env.OPS_ADMIN_USER_IDS;
  const prevViewer = process.env.OPS_VIEWER_USER_IDS;
  const prevNode = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.OPS_ADMIN_USER_IDS = "user_admin";
    process.env.OPS_VIEWER_USER_IDS = "user_viewer";
    process.env.NODE_ENV = "production";
  });

  afterEach(() => {
    if (prevAdmin === undefined) delete process.env.OPS_ADMIN_USER_IDS;
    else process.env.OPS_ADMIN_USER_IDS = prevAdmin;
    if (prevViewer === undefined) delete process.env.OPS_VIEWER_USER_IDS;
    else process.env.OPS_VIEWER_USER_IDS = prevViewer;
    if (prevNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNode;
  });

  it("resolves admin and viewer", () => {
    expect(resolveOpsRole("user_admin")).toBe("admin");
    expect(resolveOpsRole("user_viewer")).toBe("viewer");
  });

  it("fails closed for unknown users in production", () => {
    expect(resolveOpsRole("user_stranger")).toBe("none");
    expect(resolveOpsRole(null)).toBe("none");
  });
});

describe("assertManualActionsLive", () => {
  it("blocks read_only", () => {
    expect(() => assertManualActionsLive("read_only", "send")).toThrow(OpsAuthError);
  });

  it("allows live", () => {
    expect(() => assertManualActionsLive("live", "send")).not.toThrow();
  });
});
