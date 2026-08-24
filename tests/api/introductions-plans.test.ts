import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/db", () => ({ db: {} }));

vi.mock("@/lib/ops/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/auth")>();
  return {
    ...actual,
    requireOpsViewer: vi.fn().mockResolvedValue({
      userId: "user_viewer",
      role: "viewer",
      mode: "read_only",
    }),
    requireOpsAdmin: vi.fn().mockResolvedValue({
      userId: "user_admin",
      role: "admin",
      mode: "read_only",
    }),
  };
});

vi.mock("@/lib/integrations/airtable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/airtable")>();
  return { ...actual, createAirtableClient: vi.fn(() => ({})), };
});

vi.mock("@/lib/integrations/pinecone", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/pinecone")>();
  return { ...actual, createPineconeClient: vi.fn(() => ({})), };
});

vi.mock("@/lib/introduction/plan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/introduction/plan")>();
  return {
    ...actual,
    runIntroductionPreview: vi.fn(),
    listIntroductionRuns: vi.fn(),
    getRunDetail: vi.fn(),
    getAlternativesForMember: vi.fn(),
    applyPlanEdit: vi.fn(),
  };
});

const syncPineconeBeforePlan = vi.fn(async () => ({ success: true, summary: "sync ok" }));

vi.mock("@/lib/introduction/preplan-sync", () => ({
  syncPineconeBeforePlan: () => syncPineconeBeforePlan(),
}));

const previewRoute = await import("@/app/api/introductions/preview/route");
const runsRoute = await import("@/app/api/introductions/runs/route");
const runRoute = await import("@/app/api/introductions/runs/[runId]/route");
const { requireOpsAdmin, requireOpsViewer, OpsAuthError } = await import("@/lib/ops/auth");
const plan = await import("@/lib/introduction/plan");

const basePreview = {
  success: true,
  runId: "run_1",
  cityCode: "rec_city_london",
  cityName: "London",
  cycleId: "intro-rec_city_london-2026-08-16",
  cycleDate: "2026-08-16",
  seed: "seed",
  profileVersionId: null,
  deliveryMode: "simulation",
  report: {
    eligibleMembers: 4,
    matchedMembers: 4,
    groups: 2,
    unmatched: 0,
    unmatchedMembers: [],
    excluded: [],
    repeatedPairsBlocked: 0,
    invalidEmails: 0,
    missingPostcode: 0,
    allowedPairs: 6,
    avgGroupScore: 0.5,
    minGroupScore: 0.5,
    renderedEmailCount: 2,
    recipientCount: 4,
    validationFailures: [],
    minEligibleMembers: 0,
    blockedReason: null,
  },
};

function post(body: object, url = "http://localhost/api/introductions/preview"): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/introductions/preview", () => {
  beforeEach(() => {
    vi.stubEnv("AIRTABLE_GET_DATA_TOKEN", "pat_test");
    vi.stubEnv("AIRTABLE_BASE_ID", "app_test");
    vi.stubEnv("PINECONE_API_KEY", "pc_test");
    vi.stubEnv("PINECONE_INDEX_NAME", "idx_test");
    vi.clearAllMocks();
    vi.mocked(requireOpsAdmin).mockResolvedValue({
      userId: "user_admin",
      role: "admin",
      mode: "read_only",
    });
    vi.mocked(plan.runIntroductionPreview).mockResolvedValue(basePreview);
    syncPineconeBeforePlan.mockResolvedValue({ success: true, summary: "sync ok" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("POST builds a preview plan and returns the report with logs", async () => {
    const response = await previewRoute.POST(post({ cityCode: "rec_city_london" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.runId).toBe("run_1");
    expect(body.report.groups).toBe(2);
    expect(Array.isArray(body.logs)).toBe(true);
    expect(syncPineconeBeforePlan).toHaveBeenCalledTimes(1);
    expect(plan.runIntroductionPreview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cityCode: "rec_city_london" })
    );
  });

  it("POST aborts with 500 when the pre-match Pinecone sync fails", async () => {
    syncPineconeBeforePlan.mockResolvedValue({
      success: false,
      summary: "embedding failed — openai down",
    });
    const response = await previewRoute.POST(post({ cityCode: "rec_city_london" }));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.code).toBe("PINECONE_SYNC_FAILED");
    expect(plan.runIntroductionPreview).not.toHaveBeenCalled();
  });

  it("POST requires an admin", async () => {
    vi.mocked(requireOpsAdmin).mockRejectedValueOnce(
      new OpsAuthError("FORBIDDEN_ADMIN", "Admin operator role required", 403)
    );
    const response = await previewRoute.POST(post({ cityCode: "rec_city_london" }));
    expect(response.status).toBe(403);
    expect(plan.runIntroductionPreview).not.toHaveBeenCalled();
  });

  it("POST rejects an invalid cycle date", async () => {
    const response = await previewRoute.POST(
      post({ cityCode: "rec_city_london", cycleDate: "16-08-2026" })
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("INVALID_PAYLOAD");
  });

  it("POST rejects an unknown delivery mode", async () => {
    const response = await previewRoute.POST(
      post({ cityCode: "rec_city_london", deliveryMode: "broadcast" })
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("INVALID_PAYLOAD");
  });
});

describe("/api/introductions/runs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireOpsViewer).mockResolvedValue({
      userId: "user_viewer",
      role: "viewer",
      mode: "read_only",
    });
    vi.mocked(plan.listIntroductionRuns).mockResolvedValue([]);
  });

  it("GET lists runs", async () => {
    const response = await runsRoute.GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.runs)).toBe(true);
  });
});

describe("/api/introductions/runs/[runId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireOpsViewer).mockResolvedValue({
      userId: "user_viewer",
      role: "viewer",
      mode: "read_only",
    });
    vi.mocked(requireOpsAdmin).mockResolvedValue({
      userId: "user_admin",
      role: "admin",
      mode: "read_only",
    });
    vi.mocked(plan.getRunDetail).mockResolvedValue({
      run: { id: "run_1", status: "planned" },
      groups: [],
    } as unknown as NonNullable<Awaited<ReturnType<typeof plan.getRunDetail>>>);
    vi.mocked(plan.getAlternativesForMember).mockResolvedValue([]);
    vi.mocked(plan.applyPlanEdit).mockResolvedValue({
      success: true,
      summary: "Regenerated city plan",
    });
  });

  it("GET returns 404 for unknown runs", async () => {
    vi.mocked(plan.getRunDetail).mockResolvedValue(null);
    const response = await runRoute.GET(
      new NextRequest("http://localhost/api/introductions/runs/nope"),
      { params: Promise.resolve({ runId: "nope" }) }
    );
    expect(response.status).toBe(404);
  });

  it("PATCH applies plan edits", async () => {
    const request = new NextRequest("http://localhost/api/introductions/runs/run_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edit: { type: "regenerate_city" } }),
    });
    const response = await runRoute.PATCH(request, { params: Promise.resolve({ runId: "run_1" }) });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(plan.applyPlanEdit).toHaveBeenCalledWith(
      expect.anything(),
      "run_1",
      { type: "regenerate_city" }
    );
  });

  it("PATCH rejects invalid edit payloads", async () => {
    const request = new NextRequest("http://localhost/api/introductions/runs/run_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edit: { type: "explode" } }),
    });
    const response = await runRoute.PATCH(request, { params: Promise.resolve({ runId: "run_1" }) });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("INVALID_PAYLOAD");
  });

  it("PATCH surfaces plan-edit domain errors", async () => {
    const { PlanEditError } = await import("@/lib/introduction/plan");
    vi.mocked(plan.applyPlanEdit).mockRejectedValueOnce(
      new PlanEditError("PLAN_FROZEN", "The plan is frozen")
    );
    const request = new NextRequest("http://localhost/api/introductions/runs/run_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edit: { type: "regenerate_city" } }),
    });
    const response = await runRoute.PATCH(request, { params: Promise.resolve({ runId: "run_1" }) });
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.code).toBe("PLAN_FROZEN");
  });

  it("PATCH requires an admin", async () => {
    vi.mocked(requireOpsAdmin).mockRejectedValueOnce(
      new OpsAuthError("FORBIDDEN_ADMIN", "Admin operator role required", 403)
    );
    const request = new NextRequest("http://localhost/api/introductions/runs/run_1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ edit: { type: "regenerate_city" } }),
    });
    const response = await runRoute.PATCH(request, { params: Promise.resolve({ runId: "run_1" }) });
    expect(response.status).toBe(403);
  });
});
