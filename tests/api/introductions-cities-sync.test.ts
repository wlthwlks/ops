import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createTestDb } from "../helpers/test-db";

const test = await createTestDb({ introductionsV2: true });
const { db } = test;

vi.mock("@/db", () => ({ db }));

vi.mock("@/lib/ops/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/auth")>();
  return {
    ...actual,
    requireOpsAdmin: vi.fn().mockResolvedValue({ userId: "admin", role: "admin", mode: "read_only" }),
  };
});

const airtableList = vi.fn();

vi.mock("@/lib/integrations/airtable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/airtable")>();
  return {
    ...actual,
    createAirtableClient: vi.fn(() => ({ listRecords: airtableList })),
  };
});

const route = await import("@/app/api/introductions/cities/sync/route");
const { requireOpsAdmin, OpsAuthError } = await import("@/lib/ops/auth");
const { cityIntroductionSettings } = await import("@/db/schema");

afterAll(async () => {
  await test.close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("AIRTABLE_GET_DATA_TOKEN", "pat_test");
  vi.stubEnv("AIRTABLE_BASE_ID", "app_test");
  vi.mocked(requireOpsAdmin).mockResolvedValue({ userId: "admin", role: "admin", mode: "read_only" });
  airtableList.mockResolvedValue([
    { id: "rec_c1", fields: { City: "London" } },
    { id: "rec_c2", fields: { City: "Gold Coast" } },
  ]);
  await db.delete(cityIntroductionSettings);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/introductions/cities/sync", () => {
  it("syncs cities from Airtable into the settings table", async () => {
    const response = await route.POST(
      new NextRequest("http://localhost/api/introductions/cities/sync", { method: "POST" })
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.created).toBe(2);
    expect(body.stale).toBe(0);

    const rows = await db.select().from(cityIntroductionSettings);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.cityCode === "rec_c2")?.cityName).toBe("Gold Coast");
    expect(rows.every((r) => r.enabled === false)).toBe(true);
  });

  it("requires an admin", async () => {
    vi.mocked(requireOpsAdmin).mockRejectedValueOnce(
      new OpsAuthError("FORBIDDEN_ADMIN", "Admin required", 403)
    );
    const response = await route.POST(
      new NextRequest("http://localhost/api/introductions/cities/sync", { method: "POST" })
    );
    expect(response.status).toBe(403);
    expect(airtableList).not.toHaveBeenCalled();
  });
});
