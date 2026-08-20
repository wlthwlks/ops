import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import type Stripe from "stripe";
import {
  MEMBERSHIP_FIELD,
  SERVICE_ACCESS_FIELD,
  STRIPE_SUBSCRIPTION_STATUS_FIELD,
} from "@/lib/billing/service-access-sync";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

const recordIntegrationError = vi.fn(async () => undefined);

vi.mock("@/lib/forms/webhooks/store", () => ({
  recordIntegrationError: (input: unknown) => {
    void input;
    return recordIntegrationError();
  },
}));

import {
  classifyPauseTransition,
  pauseResumeDateFromSubscription,
  subscriptionPeriodEndDate,
  syncSubscriptionPausedToAirtable,
  syncSubscriptionResumedToAirtable,
} from "@/lib/billing/pause-sync";

const BILLING_PAUSE_UNTIL = MEMBER_FIELDS.billingPauseUntil;

const NOW = new Date("2026-08-20T12:00:00.000Z");

function memberRecord(overrides: Record<string, unknown> = {}): AirtableRecord {
  return {
    id: "rec1",
    fields: {
      Name: "Ada",
      email: "ada@ex.com",
      [SERVICE_ACCESS_FIELD]: "2026-12-01T00:00:00.000Z",
      [STRIPE_SUBSCRIPTION_STATUS_FIELD]: "active",
      [MEMBERSHIP_FIELD]: "Active",
      [BILLING_PAUSE_UNTIL]: "",
      ...overrides,
    },
  };
}

function mockAirtable(records: AirtableRecord[]) {
  const updateRecordsBatched = vi.fn(async (_t: string, updates: Array<{ id: string }>) =>
    updates.map((u) => ({ id: u.id, fields: {} }))
  );
  const listRecords = vi.fn(async () => records);
  return {
    listRecords,
    updateRecordsBatched,
    getRecord: vi.fn(),
    createRecords: vi.fn(),
    createRecordsBatched: vi.fn(),
    updateRecords: vi.fn(),
    updateRecordsBatchedDetailed: vi.fn(),
  } as unknown as AirtableClient & {
    listRecords: ReturnType<typeof vi.fn>;
    updateRecordsBatched: ReturnType<typeof vi.fn>;
  };
}

function pausedSub(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "paused",
    pause_collection: { behavior: "void", resumes_at: null },
    items: { data: [{ current_period_end: 1756684800 }] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function activeSub(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    pause_collection: null,
    items: { data: [{ current_period_end: 1756684800 }] },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("classifyPauseTransition", () => {
  it("detects pause collection even when Stripe status stays active", () => {
    const result = classifyPauseTransition({
      status: "active",
      pauseCollection: { behavior: "keep_as_draft", resumes_at: null },
      prevPauseCollection: undefined,
      prevStatus: undefined,
      eventType: "customer.subscription.updated",
    });
    expect(result).toBe("paused");
  });

  it("detects schedule-based pauses via status paused", () => {
    const result = classifyPauseTransition({
      status: "paused",
      pauseCollection: null,
      prevPauseCollection: undefined,
      prevStatus: "active",
      eventType: "customer.subscription.updated",
    });
    expect(result).toBe("paused");
  });

  it("detects resume when pause_collection is cleared (previous_attributes)", () => {
    const result = classifyPauseTransition({
      status: "active",
      pauseCollection: null,
      prevPauseCollection: { behavior: "void", resumes_at: null },
      prevStatus: undefined,
      eventType: "customer.subscription.updated",
    });
    expect(result).toBe("resumed");
  });

  it("detects resume via the dedicated resumed event", () => {
    const result = classifyPauseTransition({
      status: "active",
      pauseCollection: null,
      prevPauseCollection: undefined,
      prevStatus: undefined,
      eventType: "customer.subscription.resumed",
    });
    expect(result).toBe("resumed");
  });

  it("detects resume via previous status paused", () => {
    const result = classifyPauseTransition({
      status: "active",
      pauseCollection: null,
      prevPauseCollection: undefined,
      prevStatus: "paused",
      eventType: "customer.subscription.updated",
    });
    expect(result).toBe("resumed");
  });

  it("returns null for ordinary active updates without pause signals", () => {
    expect(
      classifyPauseTransition({
        status: "active",
        pauseCollection: null,
        prevPauseCollection: undefined,
        prevStatus: undefined,
        eventType: "customer.subscription.updated",
      })
    ).toBeNull();
  });
});

describe("pauseResumeDateFromSubscription", () => {
  it("returns the resume date or null when indefinite", () => {
    const future = Math.floor(Date.parse("2026-09-15T00:00:00Z") / 1000);
    expect(
      pauseResumeDateFromSubscription(
        pausedSub({ pause_collection: { behavior: "void", resumes_at: future } })
      )
    ).toBe("2026-09-15");
    expect(pauseResumeDateFromSubscription(pausedSub())).toBeNull();
    expect(
      pauseResumeDateFromSubscription(pausedSub({ pause_collection: null }))
    ).toBeNull();
  });
});

describe("subscriptionPeriodEndDate", () => {
  it("reads the period end", () => {
    expect(subscriptionPeriodEndDate(pausedSub())).toBe("2025-09-01");
    expect(
      subscriptionPeriodEndDate(pausedSub({ items: { data: [] } }))
    ).toBeNull();
  });
});

describe("syncSubscriptionPausedToAirtable", () => {
  it("writes paused state: status, pause-until, Membership, zeroed access", async () => {
    const airtable = mockAirtable([memberRecord()]);
    const result = await syncSubscriptionPausedToAirtable({
      airtable,
      sub: pausedSub(),
      now: NOW,
    });

    expect(result.status).toBe("updated");
    expect(result.airtableRecordsUpdated).toBe(1);
    const updates = airtable.updateRecordsBatched.mock.calls[0][1] as Array<{
      id: string;
      fields: Record<string, unknown>;
    }>;
    const fields = updates[0].fields;
    expect(fields[STRIPE_SUBSCRIPTION_STATUS_FIELD]).toBe("paused");
    expect(fields[BILLING_PAUSE_UNTIL] ?? "").toBe("");
    expect(fields[MEMBERSHIP_FIELD]).toBe("Paused");
    expect(fields[SERVICE_ACCESS_FIELD]).toBe(NOW.toISOString());
  });

  it("writes paused state when Stripe status stays active (pause collection)", async () => {
    const airtable = mockAirtable([memberRecord()]);
    const result = await syncSubscriptionPausedToAirtable({
      airtable,
      sub: pausedSub({ status: "active" }),
      now: NOW,
    });

    expect(result.status).toBe("updated");
    const updates = airtable.updateRecordsBatched.mock.calls[0][1] as Array<{
      fields: Record<string, unknown>;
    }>;
    expect(updates[0].fields[STRIPE_SUBSCRIPTION_STATUS_FIELD]).toBe("paused");
    expect(updates[0].fields[MEMBERSHIP_FIELD]).toBe("Paused");
  });

  it("stores the resume date for scheduled pauses", async () => {
    const future = Math.floor(Date.parse("2026-09-15T00:00:00Z") / 1000);
    const airtable = mockAirtable([memberRecord()]);
    await syncSubscriptionPausedToAirtable({
      airtable,
      sub: pausedSub({ pause_collection: { behavior: "void", resumes_at: future } }),
      now: NOW,
    });
    const updates = airtable.updateRecordsBatched.mock.calls[0][1] as Array<{
      fields: Record<string, unknown>;
    }>;
    expect(updates[0].fields[BILLING_PAUSE_UNTIL]).toBe("2026-09-15");
  });

  it("does not churn access-until when it is already in the past", async () => {
    const airtable = mockAirtable([
      memberRecord({
        [SERVICE_ACCESS_FIELD]: "2026-01-01T00:00:00.000Z",
        [STRIPE_SUBSCRIPTION_STATUS_FIELD]: "paused",
        [MEMBERSHIP_FIELD]: "Paused",
      }),
    ]);
    const result = await syncSubscriptionPausedToAirtable({
      airtable,
      sub: pausedSub(),
      now: NOW,
    });
    expect(result.status).toBe("already_up_to_date");
    expect(airtable.updateRecordsBatched).not.toHaveBeenCalled();
  });

  it("reports no_airtable_member and never creates members", async () => {
    const airtable = mockAirtable([]);
    const result = await syncSubscriptionPausedToAirtable({
      airtable,
      sub: pausedSub(),
      now: NOW,
    });
    expect(result.status).toBe("no_airtable_member");
    expect(airtable.updateRecordsBatched).not.toHaveBeenCalled();
    expect(recordIntegrationError).toHaveBeenCalled();
  });
});

describe("syncSubscriptionResumedToAirtable", () => {
  it("restores Membership, status and future period end", async () => {
    const futureEnd = Math.floor(NOW.getTime() / 1000) + 30 * 86400;
    const airtable = mockAirtable([
      memberRecord({
        [SERVICE_ACCESS_FIELD]: "2026-08-20T00:00:00.000Z",
        [STRIPE_SUBSCRIPTION_STATUS_FIELD]: "paused",
        [MEMBERSHIP_FIELD]: "Paused",
        [BILLING_PAUSE_UNTIL]: "",
      }),
    ]);
    const result = await syncSubscriptionResumedToAirtable({
      airtable,
      sub: activeSub({ items: { data: [{ current_period_end: futureEnd }] } }),
      now: NOW,
    });

    expect(result.status).toBe("updated");
    const updates = airtable.updateRecordsBatched.mock.calls[0][1] as Array<{
      fields: Record<string, unknown>;
    }>;
    const fields = updates[0].fields;
    expect(fields[STRIPE_SUBSCRIPTION_STATUS_FIELD]).toBe("active");
    expect(fields[BILLING_PAUSE_UNTIL] ?? "").toBe("");
    expect(fields[MEMBERSHIP_FIELD]).toBe("Active");
    expect(fields[SERVICE_ACCESS_FIELD]).toBe(
      new Date(futureEnd * 1000).toISOString().slice(0, 10)
    );
  });

  it("leaves access-until alone when the period lapsed during a long pause", async () => {
    const pastEnd = Math.floor(NOW.getTime() / 1000) - 10 * 86400;
    const airtable = mockAirtable([
      memberRecord({
        [SERVICE_ACCESS_FIELD]: "2026-01-01T00:00:00.000Z",
        [STRIPE_SUBSCRIPTION_STATUS_FIELD]: "paused",
        [MEMBERSHIP_FIELD]: "Paused",
      }),
    ]);
    await syncSubscriptionResumedToAirtable({
      airtable,
      sub: activeSub({ items: { data: [{ current_period_end: pastEnd }] } }),
      now: NOW,
    });
    const updates = airtable.updateRecordsBatched.mock.calls[0][1] as Array<{
      fields: Record<string, unknown>;
    }>;
    expect(updates[0].fields[SERVICE_ACCESS_FIELD]).toBeUndefined();
    expect(updates[0].fields[MEMBERSHIP_FIELD]).toBe("Active");
  });

  it("does not restore Membership while the subscription is not live", async () => {
    const airtable = mockAirtable([
      memberRecord({ [MEMBERSHIP_FIELD]: "Paused", [STRIPE_SUBSCRIPTION_STATUS_FIELD]: "paused" }),
    ]);
    await syncSubscriptionResumedToAirtable({
      airtable,
      sub: activeSub({ status: "past_due" }),
      now: NOW,
    });
    const updates = airtable.updateRecordsBatched.mock.calls[0][1] as Array<{
      fields: Record<string, unknown>;
    }>;
    expect(updates[0].fields[MEMBERSHIP_FIELD]).toBeUndefined();
    expect(updates[0].fields[STRIPE_SUBSCRIPTION_STATUS_FIELD]).toBe("past_due");
  });
});
