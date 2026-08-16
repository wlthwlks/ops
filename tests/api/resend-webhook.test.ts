import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createTestDb } from "../helpers/test-db";

const test = await createTestDb({ introductionsV2: true });
const { db } = test;

vi.mock("@/db", () => ({ db }));

vi.mock("@/lib/introduction/delivery-webhook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/introduction/delivery-webhook")>();
  return {
    ...actual,
    verifyResendWebhook: vi.fn(),
  };
});

const route = await import("@/app/api/webhooks/resend/route");
const webhookLib = await import("@/lib/introduction/delivery-webhook");
const { introductionRuns, introductionGroups, introductionDeliveries, introductionDeliveryEvents } = await import("@/db/schema");

afterAll(async () => {
  await test.close();
});

function webhookRequest(payload: unknown): NextRequest {
  return new NextRequest("http://localhost/api/webhooks/resend", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "svix-id": "msg_1",
      "svix-timestamp": "1755432000",
      "svix-signature": "v1,sig",
    },
    body: JSON.stringify(payload),
  });
}

async function seedDelivery() {
  await db.insert(introductionRuns).values({
    id: "run-w",
    requestId: "req-w",
    source: "city",
    mode: "send",
    dryRun: false,
    status: "approved",
  });
  await db.insert(introductionGroups).values({
    id: "grp-w",
    runId: "run-w",
    source: "city",
    groupFingerprint: "fp-w",
    status: "sent",
  });
  await db.insert(introductionDeliveries).values({
    id: "dl-w",
    runId: "run-w",
    groupId: "grp-w",
    recipientEmail: "a@example.com",
    deliverToEmail: "a@example.com",
    deliveryKey: "group:grp-w:a",
    status: "sent",
    resendMessageId: "resend_msg_1",
  });
}

describe("POST /api/webhooks/resend", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "whsec_test");
    await db.delete(introductionDeliveryEvents);
    await db.delete(introductionDeliveries);
    await db.delete(introductionGroups);
    await db.delete(introductionRuns);
    vi.mocked(webhookLib.verifyResendWebhook).mockReturnValue({ ok: true });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("applies a verified event and updates the delivery", async () => {
    await seedDelivery();
    const response = await route.POST(
      webhookRequest({
        created_at: 1755432000,
        type: "email.delivered",
        data: { id: "resend_msg_1", to: ["a@example.com"] },
      })
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.processed).toBe(true);
    expect(body.applied).toBe(1);

    const rows = await db.select().from(introductionDeliveries);
    expect(rows[0].status).toBe("delivered");
  });

  it("rejects invalid signatures with 401", async () => {
    vi.mocked(webhookLib.verifyResendWebhook).mockReturnValue({
      ok: false,
      error: "Signature verification failed",
    });
    const response = await route.POST(webhookRequest({ type: "email.delivered" }));
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body.code).toBe("WEBHOOK_INVALID_SIGNATURE");
  });

  it("returns 500 when the secret is not configured", async () => {
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    const response = await route.POST(webhookRequest({ type: "email.delivered" }));
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body.code).toBe("RESEND_WEBHOOK_NOT_CONFIGURED");
  });

  it("rejects non-JSON bodies with 400", async () => {
    const request = new NextRequest("http://localhost/api/webhooks/resend", {
      method: "POST",
      headers: { "Content-Type": "application/json", "svix-id": "1", "svix-timestamp": "1", "svix-signature": "1" },
      body: "not-json",
    });
    const response = await route.POST(request);
    expect(response.status).toBe(400);
  });
});
