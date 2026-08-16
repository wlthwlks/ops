import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/db", () => ({ db: {} }));

vi.mock("@/lib/ops/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/auth")>();
  return {
    ...actual,
    requireOpsAdmin: vi.fn().mockResolvedValue({
      userId: "user_admin",
      role: "admin",
      mode: "read_only",
    }),
    requireLiveAdmin: vi.fn().mockResolvedValue({
      userId: "user_admin",
      role: "admin",
      mode: "live",
    }),
  };
});

vi.mock("@/lib/introduction/freeze", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/introduction/freeze")>();
  return {
    ...actual,
    freezeIntroductionRun: vi.fn(),
  };
});

const approveRoute = await import("@/app/api/introductions/runs/[runId]/approve/route");
const { requireOpsAdmin, requireLiveAdmin, OpsAuthError } = await import("@/lib/ops/auth");
const freeze = await import("@/lib/introduction/freeze");

const frozenResult: Awaited<ReturnType<typeof freeze.freezeIntroductionRun>> = {
  success: true,
  runId: "run_1",
  planHash: "abc123",
  deliveryMode: "simulation",
  deliveryCount: 4,
  templateVersionId: "tv_1",
  validationFailures: [],
};

function approveRequest(body: object): NextRequest {
  return new NextRequest("http://localhost/api/introductions/runs/run_1/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/introductions/runs/[runId]/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireOpsAdmin).mockResolvedValue({
      userId: "user_admin",
      role: "admin",
      mode: "read_only",
    });
    vi.mocked(requireLiveAdmin).mockResolvedValue({
      userId: "user_admin",
      role: "admin",
      mode: "live",
    });
    vi.mocked(freeze.freezeIntroductionRun).mockResolvedValue(frozenResult);
  });

  it("freezes with simulation mode as an admin in read-only mode", async () => {
    const response = await approveRoute.POST(
      approveRequest({ deliveryMode: "simulation" }),
      { params: Promise.resolve({ runId: "run_1" }) }
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.deliveryCount).toBe(4);
    expect(requireLiveAdmin).not.toHaveBeenCalled();
    expect(freeze.freezeIntroductionRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ runId: "run_1", deliveryMode: "simulation" })
    );
  });

  it("requires live admin for production delivery", async () => {
    vi.mocked(requireLiveAdmin).mockRejectedValueOnce(
      new OpsAuthError("MANUAL_ACTIONS_READ_ONLY", "Dashboard is in read-only mode", 403)
    );
    const response = await approveRoute.POST(
      approveRequest({ deliveryMode: "production", confirmation: "SEND" }),
      { params: Promise.resolve({ runId: "run_1" }) }
    );
    expect(response.status).toBe(403);
    expect(freeze.freezeIntroductionRun).not.toHaveBeenCalled();
  });

  it("requires typed confirmation for production delivery", async () => {
    const response = await approveRoute.POST(
      approveRequest({ deliveryMode: "production" }),
      { params: Promise.resolve({ runId: "run_1" }) }
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("CONFIRMATION_REQUIRED");
    expect(freeze.freezeIntroductionRun).not.toHaveBeenCalled();
  });

  it("accepts production with live mode and typed confirmation", async () => {
    const response = await approveRoute.POST(
      approveRequest({ deliveryMode: "production", confirmation: "SEND" }),
      { params: Promise.resolve({ runId: "run_1" }) }
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.deliveryMode).toBe("simulation");
    expect(requireLiveAdmin).toHaveBeenCalled();
  });

  it("returns 422 for validation failures", async () => {
    vi.mocked(freeze.freezeIntroductionRun).mockResolvedValue({
      ...frozenResult,
      success: false,
      validationFailures: ["Canary delivery mode requires configured canary email addresses"],
    });
    const response = await approveRoute.POST(
      approveRequest({ deliveryMode: "canary" }),
      { params: Promise.resolve({ runId: "run_1" }) }
    );
    expect(response.status).toBe(422);
  });

  it("surfaces freeze domain errors", async () => {
    const { FreezeError } = await import("@/lib/introduction/freeze");
    vi.mocked(freeze.freezeIntroductionRun).mockRejectedValueOnce(
      new FreezeError("PLAN_ALREADY_FROZEN", "already approved")
    );
    const response = await approveRoute.POST(
      approveRequest({}),
      { params: Promise.resolve({ runId: "run_1" }) }
    );
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.code).toBe("PLAN_ALREADY_FROZEN");
  });
});
