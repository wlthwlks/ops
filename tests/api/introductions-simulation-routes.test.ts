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
    requireOpsViewer: vi.fn().mockResolvedValue({ userId: "viewer", role: "viewer", mode: "read_only" }),
    requireOpsAdmin: vi.fn().mockResolvedValue({ userId: "admin", role: "admin", mode: "read_only" }),
    requireLiveAdmin: vi.fn().mockResolvedValue({ userId: "admin", role: "admin", mode: "live" }),
  };
});

const deliveriesRoute = await import("@/app/api/introductions/deliveries/route");
const simulationRoute = await import("@/app/api/introductions/runs/[runId]/simulation/route");
const templatePreviewRoute = await import("@/app/api/introductions/templates/preview/route");
const testSendRoute = await import("@/app/api/introductions/templates/[templateId]/test-send/route");
const { requireOpsAdmin, requireLiveAdmin, OpsAuthError } = await import("@/lib/ops/auth");
const { introductionRuns, introductionGroups, introductionDeliveries, introductionDeliveryEvents } = await import("@/db/schema");

afterAll(async () => {
  await test.close();
});

async function seedRun(runId: string, deliveryMode = "canary") {
  await db.insert(introductionRuns).values({
    id: runId,
    requestId: `req-${runId}`,
    source: "city",
    mode: "send",
    dryRun: false,
    status: "approved",
    deliveryMode,
    snapshotJson: JSON.stringify({
      members: [
        { key: "at:rec_a", email: "a@example.com" },
        { key: "at:rec_b", email: "b@example.com" },
      ],
    }),
  });
  await db.insert(introductionGroups).values({
    id: `grp-${runId}`,
    runId,
    source: "city",
    groupFingerprint: `fp-${runId}`,
    status: "sent",
    emailSubjectSnapshot: "Subject",
    emailHtmlSnapshot: "<p>Body</p>",
  });
  await db.insert(introductionDeliveries).values({
    id: `dl-${runId}`,
    runId,
    groupId: `grp-${runId}`,
    recipientEmail: "a@example.com",
    deliverToEmail: deliveryMode === "canary" ? "canary@wlthwlks.com" : "a@example.com",
    originalToJson: deliveryMode === "canary" ? JSON.stringify(["a@example.com"]) : null,
    deliveryKey: `group:grp-${runId}:a`,
    status: "sent",
    resendMessageId: "resend_1",
  });
  await db.insert(introductionDeliveryEvents).values({
    id: `evt-${runId}`,
    deliveryId: `dl-${runId}`,
    eventType: "email.delivered",
    providerEventId: "resend_1",
    providerTs: new Date(),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(introductionDeliveryEvents);
  await db.delete(introductionDeliveries);
  await db.delete(introductionGroups);
  await db.delete(introductionRuns);
  vi.mocked(requireOpsAdmin).mockResolvedValue({ userId: "admin", role: "admin", mode: "read_only" });
  vi.mocked(requireLiveAdmin).mockResolvedValue({ userId: "admin", role: "admin", mode: "live" });
});

describe("GET /api/introductions/deliveries", () => {
  it("returns deliveries with original recipients and provider events", async () => {
    await seedRun("run_dl");
    const response = await deliveriesRoute.GET(
      new NextRequest("http://localhost/api/introductions/deliveries?runId=run_dl")
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.deliveries).toHaveLength(1);
    expect(body.deliveries[0].originalTo).toEqual(["a@example.com"]);
    expect(body.deliveries[0].deliverToEmail).toBe("canary@wlthwlks.com");
    expect(body.events).toHaveLength(1);
    expect(body.events[0].eventType).toBe("email.delivered");
  });

  it("rejects a missing runId", async () => {
    const response = await deliveriesRoute.GET(
      new NextRequest("http://localhost/api/introductions/deliveries")
    );
    expect(response.status).toBe(400);
  });
});

describe("GET /api/introductions/runs/[runId]/simulation", () => {
  it("returns the full simulation report", async () => {
    await seedRun("run_sim");
    const response = await simulationRoute.GET(
      new NextRequest("http://localhost/api/introductions/runs/run_sim/simulation"),
      { params: Promise.resolve({ runId: "run_sim" }) }
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.report.deliveryMode).toBe("canary");
    expect(body.report.safety.level).toBe("internal");
    expect(body.report.eligibleMembers).toBe(2);
    expect(body.report.canaryRedirectCount).toBe(1);
    expect(body.report.queue.batches).toBe(1);
  });

  it("returns 404 for unknown runs", async () => {
    const response = await simulationRoute.GET(
      new NextRequest("http://localhost/api/introductions/runs/missing/simulation"),
      { params: Promise.resolve({ runId: "missing" }) }
    );
    expect(response.status).toBe(404);
  });
});

describe("POST /api/introductions/templates/preview", () => {
  it("renders the template with sample members", async () => {
    const response = await templatePreviewRoute.POST(
      new NextRequest("http://localhost/api/introductions/templates/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: "Meet your {{city}} introductions",
          bodyHtml: "<p>Hi {{first_name}}</p>{{members}}{{coordination_text}}",
        }),
      })
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.subject).toBe("Meet your London introductions");
    expect(body.html).toContain("Sarah, Priya and James");
    expect(body.html).toContain("reply-all");
    expect(body.unknownPlaceholders).toEqual([]);
  });

  it("requires an admin", async () => {
    vi.mocked(requireOpsAdmin).mockRejectedValueOnce(
      new OpsAuthError("FORBIDDEN_ADMIN", "Admin required", 403)
    );
    const response = await templatePreviewRoute.POST(
      new NextRequest("http://localhost/api/introductions/templates/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "s", bodyHtml: "b" }),
      })
    );
    expect(response.status).toBe(403);
  });
});

describe("POST /api/introductions/templates/[templateId]/test-send", () => {
  beforeEach(() => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires live admin", async () => {
    vi.mocked(requireLiveAdmin).mockRejectedValueOnce(
      new OpsAuthError("MANUAL_ACTIONS_READ_ONLY", "read only", 403)
    );
    const response = await testSendRoute.POST(
      new NextRequest("http://localhost/api/introductions/templates/t1/test-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: "a@wlthwlks.com" }),
      }),
      { params: Promise.resolve({ templateId: "t1" }) }
    );
    expect(response.status).toBe(403);
  });
});
