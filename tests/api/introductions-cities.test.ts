import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createTestDb } from "../helpers/test-db";

const test = await createTestDb({ introductionsV2: true });
const { db } = test;

vi.mock("@/db", () => ({ db }));

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

const route = await import("@/app/api/introductions/cities/[cityCode]/route");
const { requireLiveAdmin, OpsAuthError } = await import("@/lib/ops/auth");

afterAll(async () => {
  await test.close();
});

function makeRequest(body: object, cityCode = "rec_london"): NextRequest {
  return new NextRequest(`http://localhost/api/introductions/cities/${cityCode}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/introductions/cities/[cityCode]", () => {
  beforeEach(() => {
    vi.mocked(requireLiveAdmin).mockResolvedValue({
      userId: "user_admin",
      role: "admin",
      mode: "live",
    });
  });

  it("PUT creates city settings and returns the effective config", async () => {
    const response = await route.PUT(
      makeRequest({
        cityName: "London",
        enabled: true,
        repeatPairDays: 90,
        schedulingMode: "scheduled",
        scheduleJson: JSON.stringify({ dayOfMonth: 1, localTime: "09:00", timezone: "Europe/London" }),
      }),
      { params: Promise.resolve({ cityCode: "rec_london" }) }
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.city.cityCode).toBe("rec_london");
    expect(body.effective.enabled).toBe(true);
    expect(body.effective.constraints.repeatPairDays).toBe(90);
    expect(body.effective.groupSizes).toEqual({ target: 3, min: 2, max: 6, strict: false });
    expect(body.effective.schedule?.dayOfMonth).toBe(1);
  });

  it("PUT rejects an invalid schedule with 400", async () => {
    const response = await route.PUT(
      makeRequest({ scheduleJson: JSON.stringify({ dayOfMonth: 40, localTime: "9", timezone: "UTC" }) }),
      { params: Promise.resolve({ cityCode: "rec_bad" }) }
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("INVALID_PAYLOAD");
  });

  it("PUT rejects inconsistent group sizes with 400", async () => {
    const response = await route.PUT(
      makeRequest({ minGroupSize: 7, maxGroupSize: 4 }),
      { params: Promise.resolve({ cityCode: "rec_bad" }) }
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.code).toBe("INVALID_PAYLOAD");
  });

  it("PUT requires a live admin", async () => {
    vi.mocked(requireLiveAdmin).mockRejectedValueOnce(
      new OpsAuthError("FORBIDDEN", "Admins only", 403)
    );
    const response = await route.PUT(
      makeRequest({ enabled: true }),
      { params: Promise.resolve({ cityCode: "rec_london" }) }
    );
    expect(response.status).toBe(403);
  });

  it("GET returns built-in defaults for a city with no settings", async () => {
    const response = await route.GET(new NextRequest("http://localhost/api/introductions/cities/rec_nowhere"), {
      params: Promise.resolve({ cityCode: "rec_nowhere" }),
    });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.city).toBeNull();
    expect(body.effective.enabled).toBe(false);
    expect(body.effective.groupSizes.target).toBe(3);
    expect(body.effective.constraints.requireSameCity).toBe(true);
  });

  it("GET returns the stored city plus effective settings", async () => {
    await route.PUT(
      makeRequest({ cityName: "Paris", enabled: true }, "rec_paris"),
      { params: Promise.resolve({ cityCode: "rec_paris" }) }
    );
    const response = await route.GET(new NextRequest("http://localhost/api/introductions/cities/rec_paris"), {
      params: Promise.resolve({ cityCode: "rec_paris" }),
    });
    const body = await response.json();
    expect(body.city.cityName).toBe("Paris");
    expect(body.effective.enabled).toBe(true);
  });
});
