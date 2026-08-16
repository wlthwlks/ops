import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  MAX_ATTEMPTS,
  processDeliveryBatch,
  resetStaleClaims,
  type DeliveryQueueDeps,
} from "@/lib/introduction/delivery-queue";
import {
  introductionRuns,
  introductionGroups,
  introductionGroupMembers,
  introductionDeliveries,
} from "@/db/schema";
import { eq } from "drizzle-orm";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

const sender = {
  sendBatch: vi.fn(),
};

function deps(live = true): DeliveryQueueDeps {
  return {
    db,
    sender,
    log: () => {},
    live,
    now: new Date("2026-08-17T10:00:00Z"),
  };
}

async function seedPlan(opts: {
  runId?: string;
  groupCount?: number;
  membersPerGroup?: number;
  deliveryMode?: string;
  runStatus?: string;
  groupStatus?: string;
  canary?: boolean;
} = {}) {
  const runId = opts.runId ?? crypto.randomUUID();
  const groupCount = opts.groupCount ?? 1;
  const membersPerGroup = opts.membersPerGroup ?? 2;
  const deliveryMode = opts.deliveryMode ?? "production";
  const runStatus = opts.runStatus ?? "approved";
  const groupStatus = opts.groupStatus ?? "approved";
  const canary = opts.canary ?? false;

  await db.insert(introductionRuns).values({
    id: runId,
    requestId: `req-${runId}`,
    source: "city",
    mode: "send",
    dryRun: false,
    status: runStatus,
    deliveryMode,
  });

  const groupIds: string[] = [];
  for (let g = 0; g < groupCount; g++) {
    const groupId = `grp-${runId}-${g}`;
    groupIds.push(groupId);
    await db.insert(introductionGroups).values({
      id: groupId,
      runId,
      source: "city",
      groupFingerprint: `fp-${groupId}`,
      status: groupStatus,
      emailSubjectSnapshot: "Subject here",
      emailHtmlSnapshot: "<p>Body here</p>",
      cityName: "London",
    });
    for (let m = 0; m < membersPerGroup; m++) {
      const email = `m${m}-${runId}@example.com`;
      await db.insert(introductionGroupMembers).values({
        id: `gm-${groupId}-${m}`,
        groupId,
        emailSnapshot: email,
        role: "recurring",
        memberSnapshotJson: JSON.stringify({ key: `em:${email}`, email, name: `M${m}` }),
      });
      await db.insert(introductionDeliveries).values({
        id: `dl-${groupId}-${m}`,
        runId,
        groupId,
        recipientEmail: email,
        deliverToEmail: canary ? "canary@wlthwlks.com" : email,
        originalToJson: canary ? JSON.stringify([email]) : null,
        deliveryKey: `group:${groupId}:${m}`,
        status: "pending",
        attemptCount: 0,
      });
    }
  }
  return { runId, groupIds };
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
  vi.clearAllMocks();
  await resetIntroductionsV2Tables(db);
  sender.sendBatch.mockImplementation(async (messages: Array<{ groupId: string }>) =>
    messages.map((m) => ({ ok: true, permanent: false, id: `resend-${m.groupId}` }))
  );
});

describe("processDeliveryBatch — happy path", () => {
  it("sends one email per group with all recipients and idempotency keys", async () => {
    const { runId } = await seedPlan({ groupCount: 2, membersPerGroup: 2 });

    const result = await processDeliveryBatch(deps(), { batchSize: 10 });
    expect(result.claimed).toBe(2);
    expect(result.sent).toBe(2);

    expect(sender.sendBatch).toHaveBeenCalledTimes(1);
    const messages = sender.sendBatch.mock.calls[0][0];
    expect(messages).toHaveLength(2);
    for (const message of messages) {
      expect(message.to).toHaveLength(2);
      expect(message.subject).toBe("Subject here");
      expect(message.html).toBe("<p>Body here</p>");
      expect(message.idempotencyKey).toBe(`intro-${runId}-${message.groupId}`);
      expect(message.replyTo).toEqual(message.to);
    }

    const deliveries = await db.select().from(introductionDeliveries);
    expect(deliveries).toHaveLength(4);
    for (const delivery of deliveries) {
      expect(delivery.status).toBe("sent");
      expect(delivery.resendMessageId).toMatch(/^resend-grp-/);
    }
    const groups = await db.select().from(introductionGroups);
    expect(groups.every((g) => g.status === "sent")).toBe(true);

    const runs = await db.select().from(introductionRuns).where(eq(introductionRuns.id, runId));
    expect(runs[0].status).toBe("completed");
  });

  it("never sends when not live", async () => {
    await seedPlan();
    const result = await processDeliveryBatch(deps(false));
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("read_only");
    expect(sender.sendBatch).not.toHaveBeenCalled();
  });

  it("never claims simulation runs", async () => {
    await seedPlan({ deliveryMode: "simulation" });
    const result = await processDeliveryBatch(deps());
    expect(result.claimed).toBe(0);
    expect(sender.sendBatch).not.toHaveBeenCalled();
  });

  it("respects the batch size limit", async () => {
    await seedPlan({ groupCount: 5 });
    const result = await processDeliveryBatch(deps(), { batchSize: 3 });
    expect(result.claimed).toBe(3);
    expect(sender.sendBatch.mock.calls[0][0]).toHaveLength(3);

    // Remaining groups are still claimable.
    const second = await processDeliveryBatch(deps(), { batchSize: 3 });
    expect(second.claimed).toBe(2);
  });

  it("sends canary-delivered addresses while keeping recipients intact", async () => {
    await seedPlan({ canary: true });
    const result = await processDeliveryBatch(deps());
    expect(result.sent).toBe(1);
    const messages = sender.sendBatch.mock.calls[0][0];
    expect(messages[0].to).toEqual(["canary@wlthwlks.com"]);
    const deliveries = await db.select().from(introductionDeliveries);
    expect(deliveries[0].recipientEmail).toContain("@example.com");
    expect(deliveries[0].deliverToEmail).toBe("canary@wlthwlks.com");
  });
});

describe("processDeliveryBatch — retries and failures", () => {
  it("defers transient failures with backoff and retries later", async () => {
    await seedPlan();
    sender.sendBatch.mockResolvedValueOnce([
      { ok: false, permanent: false, error: "rate_limit_exceeded" },
    ]);

    const first = await processDeliveryBatch(deps());
    expect(first.deferred).toBe(1);

    const deliveries = await db.select().from(introductionDeliveries);
    for (const delivery of deliveries) {
      expect(delivery.status).toBe("pending");
      expect(delivery.nextRetryAt).not.toBeNull();
      expect(delivery.error).toContain("rate_limit");
    }
    const groups = await db.select().from(introductionGroups);
    expect(groups[0].status).toBe("approved");

    // Immediately retrying skips the group (next_retry_at in the future).
    const skipped = await processDeliveryBatch(deps());
    expect(skipped.claimed).toBe(0);

    // After the backoff window the group is claimable again.
    const later = await processDeliveryBatch({
      ...deps(),
      now: new Date("2026-08-17T10:05:00Z"),
    });
    expect(later.claimed).toBe(1);
    expect(later.sent).toBe(1);
  });

  it("fails permanently without retrying", async () => {
    await seedPlan();
    sender.sendBatch.mockResolvedValueOnce([
      { ok: false, permanent: true, error: "invalid_from_address" },
    ]);

    const result = await processDeliveryBatch(deps());
    expect(result.failed).toBe(1);

    const deliveries = await db.select().from(introductionDeliveries);
    expect(deliveries.every((d) => d.status === "failed")).toBe(true);
    const groups = await db.select().from(introductionGroups);
    expect(groups[0].status).toBe("failed");

    const second = await processDeliveryBatch(deps());
    expect(second.claimed).toBe(0);
    expect(sender.sendBatch).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after the attempt limit", async () => {
    await seedPlan();
    const { runId } = await seedPlan();
    sender.sendBatch.mockResolvedValue([
      { ok: false, permanent: false, error: "provider_timeout" },
    ]);

    for (let attempt = 0; attempt < MAX_ATTEMPTS + 1; attempt++) {
      const now = new Date(Date.parse("2026-08-17T10:00:00Z") + attempt * 60 * 60 * 1000);
      await processDeliveryBatch({ ...deps(), now });
    }

    const deliveries = await db.select().from(introductionDeliveries);
    for (const delivery of deliveries) {
      expect(delivery.status === "failed" || delivery.attemptCount > MAX_ATTEMPTS).toBe(true);
    }
    const groups = await db.select().from(introductionGroups);
    expect(groups.some((g) => g.status === "failed")).toBe(true);
    void runId;
  });

  it("recovers groups stranded by a crashed worker via stale-claim reset", async () => {
    await seedPlan();
    const deliveries = await db.select().from(introductionDeliveries);
    for (const delivery of deliveries) {
      await db
        .update(introductionDeliveries)
        .set({ status: "processing", claimedAt: new Date("2026-08-17T09:00:00Z") })
        .where(eq(introductionDeliveries.id, delivery.id));
    }
    const groups = await db.select().from(introductionGroups);
    for (const group of groups) {
      await db
        .update(introductionGroups)
        .set({ status: "sending", claimedAt: new Date("2026-08-17T09:00:00Z") })
        .where(eq(introductionGroups.id, group.id));
    }

    const result = await processDeliveryBatch(deps());
    expect(result.reclaimed).toBeGreaterThan(0);
    expect(result.sent).toBe(1);

    const after = await db.select().from(introductionDeliveries);
    expect(after.every((d) => d.status === "sent")).toBe(true);
  });
});

describe("resetStaleClaims", () => {
  it("reclaims only claims older than the window", async () => {
    await seedPlan();
    const deliveries = await db.select().from(introductionDeliveries);
    for (const delivery of deliveries) {
      await db
        .update(introductionDeliveries)
        .set({ status: "processing", claimedAt: new Date("2026-08-17T09:00:00Z") })
        .where(eq(introductionDeliveries.id, delivery.id));
    }
    const groups = await db.select().from(introductionGroups);
    for (const group of groups) {
      await db
        .update(introductionGroups)
        .set({ status: "sending", claimedAt: new Date("2026-08-17T09:00:00Z") })
        .where(eq(introductionGroups.id, group.id));
    }

    const result = await resetStaleClaims(db, {
      now: new Date("2026-08-17T10:00:00Z"),
      staleMinutes: 10,
    });
    expect(result.deliveries).toBe(2);
    expect(result.groups).toBe(1);
  });

  it("leaves fresh claims alone", async () => {
    await seedPlan();
    const deliveries = await db.select().from(introductionDeliveries);
    for (const delivery of deliveries) {
      await db
        .update(introductionDeliveries)
        .set({ status: "processing", claimedAt: new Date("2026-08-17T09:59:00Z") })
        .where(eq(introductionDeliveries.id, delivery.id));
    }
    const result = await resetStaleClaims(db, {
      now: new Date("2026-08-17T10:00:00Z"),
      staleMinutes: 10,
    });
    expect(result.deliveries).toBe(0);
  });
});
