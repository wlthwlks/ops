import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/db", () => ({ db: {} }));

vi.mock("@/lib/ops/cron-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/cron-auth")>();
  return {
    ...actual,
    rejectUnauthorizedCron: vi.fn().mockReturnValue(null),
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

vi.mock("@/lib/ops/sync-intro-profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/sync-intro-profiles")>();
  return {
    ...actual,
    runIntroProfileSync: vi.fn(),
    reconcileSemanticNamespace: vi.fn(),
  };
});

const route = await import("@/app/api/cron/pinecone-semantic-cleanup/route");
const { rejectUnauthorizedCron } = await import("@/lib/ops/cron-auth");
const sync = await import("@/lib/ops/sync-intro-profiles");

const SYNC_RESULT = {
  success: true,
  summary: "All Cities: 2 embedded (8 vectors), 100 unchanged",
  fetched: 102,
  embedded: 2,
  vectorsUpserted: 8,
  skipped: 0,
  unchanged: 100,
  deletedVectors: 3,
  errors: [],
  dryRun: false,
  namespace: "intro_v2",
};

describe("GET /api/cron/pinecone-semantic-cleanup", () => {
  beforeEach(() => {
    vi.stubEnv("AIRTABLE_GET_DATA_TOKEN", "pat_test");
    vi.stubEnv("AIRTABLE_BASE_ID", "app_test");
    vi.stubEnv("PINECONE_API_KEY", "pc_test");
    vi.stubEnv("PINECONE_INDEX_NAME", "idx_test");
    vi.stubEnv("OPENAI_API_KEY", "sk_test");
    vi.stubEnv("INTRO_PINECONE_CLEANUP_CRON_ENABLED", "true");
    vi.clearAllMocks();
    vi.mocked(rejectUnauthorizedCron).mockReturnValue(null);
    vi.mocked(sync.runIntroProfileSync).mockResolvedValue(SYNC_RESULT);
    vi.mocked(sync.reconcileSemanticNamespace).mockResolvedValue({
      deletedVectors: 3,
      namespaceVectorCount: 500,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects unauthorized requests", async () => {
    vi.mocked(rejectUnauthorizedCron).mockReturnValueOnce(
      NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 })
    );
    const response = await route.GET(
      new NextRequest("http://localhost/api/cron/pinecone-semantic-cleanup")
    );
    expect(response.status).toBe(401);
    expect(sync.runIntroProfileSync).not.toHaveBeenCalled();
  });

  it("skips when the env gate is off", async () => {
    vi.stubEnv("INTRO_PINECONE_CLEANUP_CRON_ENABLED", "");
    const response = await route.GET(
      new NextRequest("http://localhost/api/cron/pinecone-semantic-cleanup")
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.skipped).toBe(true);
    expect(sync.runIntroProfileSync).not.toHaveBeenCalled();
  });

  it("runs the full all-cities self-healing sync", async () => {
    const response = await route.GET(
      new NextRequest("http://localhost/api/cron/pinecone-semantic-cleanup")
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.embedded).toBe(2);
    expect(body.deletedVectors).toBe(3);
    expect(sync.runIntroProfileSync).toHaveBeenCalledWith(
      expect.anything(),
      { cityLabel: "All Cities" }
    );
    expect(sync.reconcileSemanticNamespace).not.toHaveBeenCalled();
  });

  it("degrades to delete-only reconcile when OPENAI_API_KEY is missing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const response = await route.GET(
      new NextRequest("http://localhost/api/cron/pinecone-semantic-cleanup")
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.degraded).toBe(true);
    expect(body.deletedVectors).toBe(3);
    expect(sync.runIntroProfileSync).not.toHaveBeenCalled();
    expect(sync.reconcileSemanticNamespace).toHaveBeenCalledWith(
      expect.anything(),
      { namespace: "intro_v2" }
    );
  });

  it("reports missing integration config", async () => {
    vi.stubEnv("PINECONE_API_KEY", "");
    const response = await route.GET(
      new NextRequest("http://localhost/api/cron/pinecone-semantic-cleanup")
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toContain("Pinecone not configured");
  });

  it("returns a 500 when the sync throws", async () => {
    vi.mocked(sync.runIntroProfileSync).mockRejectedValueOnce(new Error("boom"));
    const response = await route.GET(
      new NextRequest("http://localhost/api/cron/pinecone-semantic-cleanup")
    );
    expect(response.status).toBe(500);
  });
});
