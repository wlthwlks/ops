import { describe, it, expect, afterAll, beforeAll, beforeEach } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  applyResendWebhookEvent,
  verifyResendWebhook,
} from "@/lib/introduction/delivery-webhook";
import {
  introductionRuns,
  introductionGroups,
  introductionDeliveries,
  introductionDeliveryEvents,
} from "@/db/schema";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

const NOW = new Date("2026-08-17T12:00:00Z");

async function seedDelivery(overrides: Partial<typeof introductionDeliveries.$inferInsert> = {}) {
  const runId = "run-webhook";
  const groupId = "grp-webhook";
  await db
    .insert(introductionRuns)
    .values({ id: runId, requestId: "req-webhook", source: "city", mode: "send", dryRun: false, status: "approved" })
    .onConflictDoNothing();
  await db
    .insert(introductionGroups)
    .values({ id: groupId, runId, source: "city", groupFingerprint: "fp-webhook", status: "sent" })
    .onConflictDoNothing();
  const [delivery] = await db
    .insert(introductionDeliveries)
    .values({
      id: "dl-webhook",
      runId,
      groupId,
      recipientEmail: "a@example.com",
      deliverToEmail: "a@example.com",
      deliveryKey: "group:grp-webhook:a",
      status: "sent",
      resendMessageId: "resend_msg_1",
      ...overrides,
    })
    .onConflictDoNothing()
    .returning();
  return delivery;
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    created_at: 1755432000,
    type: "email.delivered",
    data: { id: "resend_msg_1", to: ["a@example.com"] },
    ...overrides,
  };
}

beforeAll(async () => {
  const test = await createTestDb({ introductionsV2: true });
  db = test.db;
  close = test.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  await resetIntroductionsV2Tables(db);
});

describe("verifyResendWebhook", () => {
  it("rejects missing headers", () => {
    const result = verifyResendWebhook("{}", { id: null, timestamp: null, signature: null }, "secret");
    expect(result.ok).toBe(false);
  });

  it("rejects a bad signature", () => {
    const result = verifyResendWebhook(
      "{}",
      { id: "msg_1", timestamp: "1755432000", signature: "v1,deadbeef" },
      "whsec_test"
    );
    expect(result.ok).toBe(false);
  });
});

describe("applyResendWebhookEvent", () => {
  it("applies delivered and updates the delivery status", async () => {
    await seedDelivery();
    const result = await applyResendWebhookEvent(db, event(), { now: NOW });
    expect(result.applied).toBe(1);

    const rows = await db.select().from(introductionDeliveries);
    expect(rows[0].status).toBe("delivered");
    expect(rows[0].lastEventAt).not.toBeNull();

    const events = await db.select().from(introductionDeliveryEvents);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("email.delivered");
    expect(events[0].providerEventId).toBe("resend_msg_1");
  });

  it("is idempotent for duplicate events", async () => {
    await seedDelivery();
    await applyResendWebhookEvent(db, event(), { now: NOW });
    const second = await applyResendWebhookEvent(db, event(), { now: NOW });
    expect(second.applied).toBe(0);
    expect(second.ignoredReasons[0]).toContain("Duplicate");

    const events = await db.select().from(introductionDeliveryEvents);
    expect(events).toHaveLength(1);
  });

  it("ignores out-of-order events", async () => {
    await seedDelivery();
    await applyResendWebhookEvent(db, event({ created_at: 1755432000 }), { now: NOW });

    const older = await applyResendWebhookEvent(
      db,
      event({ type: "email.bounced", created_at: 1755431000 }),
      { now: NOW }
    );
    expect(older.applied).toBe(0);
    expect(older.ignoredReasons.join(" ")).toContain("Out-of-order");

    const rows = await db.select().from(introductionDeliveries);
    expect(rows[0].status).toBe("delivered");
  });

  it("maps terminal statuses and keeps them absorbing", async () => {
    await seedDelivery();
    await applyResendWebhookEvent(db, event({ type: "email.bounced" }), { now: NOW });

    let rows = await db.select().from(introductionDeliveries);
    expect(rows[0].status).toBe("bounced");

    // A later delivered event must not resurrect a bounced delivery.
    await applyResendWebhookEvent(db, event({ created_at: 1755432100 }), { now: NOW });
    rows = await db.select().from(introductionDeliveries);
    expect(rows[0].status).toBe("bounced");
  });

  it("records opened/clicked without changing the delivery status", async () => {
    await seedDelivery();
    await applyResendWebhookEvent(db, event({ type: "email.opened" }), { now: NOW });
    const rows = await db.select().from(introductionDeliveries);
    expect(rows[0].status).toBe("sent");
    const events = await db.select().from(introductionDeliveryEvents);
    expect(events[0].eventType).toBe("email.opened");
  });

  it("matches recipients case-insensitively and ignores unknown message ids", async () => {
    await seedDelivery();
    const result = await applyResendWebhookEvent(
      db,
      event({ data: { id: "resend_msg_1", to: ["A@Example.com"] } }),
      { now: NOW }
    );
    expect(result.applied).toBe(1);

    const unknown = await applyResendWebhookEvent(
      db,
      event({ data: { id: "resend_unknown", to: ["a@example.com"] } }),
      { now: NOW }
    );
    expect(unknown.applied).toBe(0);
    expect(unknown.ignored).toBe(0);
  });

  it("ignores unsupported event types", async () => {
    await seedDelivery();
    const result = await applyResendWebhookEvent(db, event({ type: "email.forwarded" }), {
      now: NOW,
    });
    expect(result.applied).toBe(0);
    expect(result.ignored).toBe(1);
  });
});
