import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  introductionRuns,
  introductionGroups,
  introductionDeliveries,
} from "@/db/schema";
import {
  listLiveDeliveryStates,
  normalizeResendLastEvent,
} from "@/lib/introduction/resend-delivery-status";
import type { ResendEmailSummary } from "@/lib/integrations/resend-emails";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

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

function email(overrides: Partial<ResendEmailSummary> = {}): ResendEmailSummary {
  return {
    id: "resend_1",
    messageId: null,
    to: ["alice@example.com"],
    from: "WLTH WLKS <noreply@wlthwlks.com>",
    createdAt: "2026-09-01 20:40:14.359+00",
    subject: "Introductions for Boulder",
    lastEvent: "delivered",
    ...overrides,
  };
}

async function seedDeliveries() {
  const runId = "run_1";
  await db.insert(introductionRuns).values({
    id: runId,
    requestId: "req_1",
    source: "city",
    mode: "preview",
    status: "completed",
    deliveryMode: "production",
    cycleDate: "2026-09-01",
  });
  const groupId = "group_1";
  await db.insert(introductionGroups).values({
    id: groupId,
    runId,
    source: "city",
    cycleId: "intro-city-2026-09-01",
    groupFingerprint: "fp_1",
    status: "sent",
    cityCode: "rec_city_boulder",
    cityName: "Boulder",
  });
  await db.insert(introductionDeliveries).values([
    {
      id: "delivery_1",
      runId,
      groupId,
      recipientEmail: "alice@example.com",
      recipientName: "Alice",
      deliverToEmail: "alice@example.com",
      deliveryKey: "key_1",
      status: "sent",
      resendMessageId: "resend_1",
    },
    {
      id: "delivery_2",
      runId,
      groupId,
      recipientEmail: "bob@example.com",
      deliverToEmail: "bob@example.com",
      deliveryKey: "key_2",
      status: "sent",
      resendMessageId: "resend_2",
    },
  ]);
}

describe("normalizeResendLastEvent", () => {
  it("maps delivery_delayed to delayed and blank to sent", () => {
    expect(normalizeResendLastEvent("delivery_delayed")).toBe("delayed");
    expect(normalizeResendLastEvent(null)).toBe("sent");
    expect(normalizeResendLastEvent("bounced")).toBe("bounced");
  });
});

describe("listLiveDeliveryStates", () => {
  it("merges Resend emails with deliveries on the stored message id", async () => {
    await seedDeliveries();
    const rows = await listLiveDeliveryStates(
      db,
      [email(), email({ id: "resend_2", to: ["bob@example.com"], lastEvent: "bounced" })],
      {}
    );
    expect(rows).toHaveLength(2);
    const byRecipient = new Map(rows.map((r) => [r.recipientEmail, r]));
    expect(byRecipient.get("alice@example.com")?.status).toBe("delivered");
    expect(byRecipient.get("alice@example.com")?.storedStatus).toBe("sent");
    expect(byRecipient.get("alice@example.com")?.cityName).toBe("Boulder");
    expect(byRecipient.get("alice@example.com")?.source).toBe("city");
    expect(byRecipient.get("alice@example.com")?.deliveryMode).toBe("production");
    expect(byRecipient.get("alice@example.com")?.sentAt).toBe("2026-09-01 20:40:14.359+00");
    expect(byRecipient.get("bob@example.com")?.status).toBe("bounced");
  });

  it("only returns emails that match a delivery", async () => {
    await seedDeliveries();
    const rows = await listLiveDeliveryStates(
      db,
      [email({ id: "resend_unknown", to: ["ghost@example.com"] })],
      {}
    );
    expect(rows).toHaveLength(0);
  });

  it("filters by live status", async () => {
    await seedDeliveries();
    const rows = await listLiveDeliveryStates(
      db,
      [email(), email({ id: "resend_2", to: ["bob@example.com"], lastEvent: "bounced" })],
      { statuses: ["bounced"] }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.recipientEmail).toBe("bob@example.com");
  });

  it("filters by person and city", async () => {
    await seedDeliveries();
    const byPerson = await listLiveDeliveryStates(
      db,
      [email(), email({ id: "resend_2", to: ["bob@example.com"], lastEvent: "delivered" })],
      { person: "bob" }
    );
    expect(byPerson).toHaveLength(1);
    expect(byPerson[0]?.recipientEmail).toBe("bob@example.com");

    const byCity = await listLiveDeliveryStates(
      db,
      [email(), email({ id: "resend_2", to: ["bob@example.com"], lastEvent: "delivered" })],
      { cityCode: "rec_city_boulder" }
    );
    expect(byCity).toHaveLength(2);

    const wrongCity = await listLiveDeliveryStates(
      db,
      [email(), email({ id: "resend_2", to: ["bob@example.com"], lastEvent: "delivered" })],
      { cityCode: "rec_city_other" }
    );
    expect(wrongCity).toHaveLength(0);
  });

  it("normalizes delivery_delayed statuses from Resend", async () => {
    await seedDeliveries();
    const rows = await listLiveDeliveryStates(
      db,
      [email({ lastEvent: "delivery_delayed" })],
      {}
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("delayed");
  });
});
