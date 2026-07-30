import { describe, it, expect, vi } from "vitest";
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import {
  applyAutoMatches,
  buildFreshSnapshotMaps,
  revalidateAutoMatchAgainstSnapshot,
  toSnapshotMember,
} from "@/lib/billing/reconcile-apply";
import {
  classifyCandidate,
  normalizeEmailStrict,
  type AirtableMemberCandidate,
  type ReconcileRow,
  type StripeCustomerCandidate,
} from "@/lib/billing/reconcile-stripe-customers";
import { STRIPE_CUSTOMER_ID_FIELD } from "@/lib/billing/service-access-sync";

function member(
  partial: Partial<AirtableMemberCandidate> & { recordId: string }
): AirtableMemberCandidate {
  const email = partial.email ?? "";
  return {
    recordId: partial.recordId,
    name: partial.name ?? "Test",
    email,
    normalizedEmail: email ? normalizeEmailStrict(email) : "",
    slackEmail: partial.slackEmail ?? "",
    existingStripeCustomerId: partial.existingStripeCustomerId ?? "",
    serviceAccessUntil: partial.serviceAccessUntil ?? "",
  };
}

function stripe(
  partial: Partial<StripeCustomerCandidate> & { id: string }
): StripeCustomerCandidate {
  const email = partial.email ?? "a@ex.com";
  return {
    id: partial.id,
    email,
    normalizedEmail: normalizeEmailStrict(email),
    created: partial.created ?? 1,
    livemode: partial.livemode ?? false,
  };
}

const billingOk = {
  ok: true,
  hasPaidInvoices: true,
  hasQualifyingMembership: true,
  latestPaidThroughIso: "2026-10-01T00:00:00.000Z",
  periodValid: true,
};

function autoRow(recordId: string, email: string, cus: string): ReconcileRow {
  return classifyCandidate({
    member: member({ recordId, email }),
    airtableRecordsForEmail: 1,
    stripeCandidates: [stripe({ id: cus, email })],
    assignedElsewhere: new Set(),
    billing: billingOk,
  });
}

function rec(id: string, email: string, cus = ""): AirtableRecord {
  return {
    id,
    fields: {
      email,
      ...(cus ? { [STRIPE_CUSTOMER_ID_FIELD]: cus } : {}),
    },
  };
}

describe("buildFreshSnapshotMaps / revalidateAutoMatchAgainstSnapshot", () => {
  it("builds maps by record, email, and customer id", () => {
    const maps = buildFreshSnapshotMaps([
      rec("r1", "a@ex.com"),
      rec("r2", "b@ex.com", "cus_b"),
      rec("r3", "A@Ex.com"),
    ]);
    expect(maps.byRecordId.size).toBe(3);
    expect(maps.byNormalizedEmail.get("a@ex.com")?.length).toBe(2);
    expect(maps.byStripeCustomerId.get("cus_b")?.[0].recordId).toBe("r2");
  });

  it("allows clean auto_match", () => {
    const row = autoRow("r1", "a@ex.com", "cus_1");
    const maps = buildFreshSnapshotMaps([rec("r1", "a@ex.com")]);
    const r = revalidateAutoMatchAgainstSnapshot(row, maps, new Set());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.update.fields[STRIPE_CUSTOMER_ID_FIELD]).toBe("cus_1");
    }
  });

  it("skips when stripe id already set", () => {
    const row = autoRow("r1", "a@ex.com", "cus_1");
    const maps = buildFreshSnapshotMaps([rec("r1", "a@ex.com", "cus_other")]);
    const r = revalidateAutoMatchAgainstSnapshot(row, maps, new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("stripe_customer_id_already_set");
  });

  it("skips when email changed", () => {
    const row = autoRow("r1", "a@ex.com", "cus_1");
    const maps = buildFreshSnapshotMaps([rec("r1", "changed@ex.com")]);
    const r = revalidateAutoMatchAgainstSnapshot(row, maps, new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("email_changed_before_apply");
  });

  it("skips duplicate emails", () => {
    const row = autoRow("r1", "a@ex.com", "cus_1");
    const maps = buildFreshSnapshotMaps([rec("r1", "a@ex.com"), rec("r2", "a@ex.com")]);
    const r = revalidateAutoMatchAgainstSnapshot(row, maps, new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("duplicate_email_detected_before_apply");
  });

  it("skips customer id conflict", () => {
    const row = autoRow("r1", "a@ex.com", "cus_1");
    const maps = buildFreshSnapshotMaps([
      rec("r1", "a@ex.com"),
      rec("r2", "b@ex.com", "cus_1"),
    ]);
    const r = revalidateAutoMatchAgainstSnapshot(row, maps, new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("stripe_customer_id_conflict_before_apply");
  });

  it("skips reserved customer ids from earlier candidates in same apply", () => {
    const row = autoRow("r1", "a@ex.com", "cus_1");
    const maps = buildFreshSnapshotMaps([rec("r1", "a@ex.com")]);
    const r = revalidateAutoMatchAgainstSnapshot(row, maps, new Set(["cus_1"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("stripe_customer_id_conflict_before_apply");
  });

  it("skips missing records", () => {
    const row = autoRow("r_missing", "a@ex.com", "cus_1");
    const maps = buildFreshSnapshotMaps([rec("r1", "a@ex.com")]);
    const r = revalidateAutoMatchAgainstSnapshot(row, maps, new Set());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("record_missing_before_apply");
  });
});

describe("applyAutoMatches", () => {
  function mockAirtable(snapshot: AirtableRecord[]) {
    const listRecords = vi.fn(async () => snapshot);
    const getRecord = vi.fn(async (table: string, id: string) => {
      const found = snapshot.find((r) => r.id === id);
      if (!found) throw new Error("not found");
      return found;
    });
    const updateRecordsBatchedDetailed = vi.fn(
      async (
        _t: string,
        updates: Array<{ id: string; fields: Record<string, unknown> }>,
        options?: { batchSize?: number; onBatch?: (i: unknown) => void; gapMs?: number }
      ) => {
        const batchSize = options?.batchSize ?? 10;
        const successIds: string[] = [];
        const results: AirtableRecord[] = [];
        const totalBatches = Math.ceil(updates.length / batchSize) || 0;
        for (let i = 0; i < updates.length; i += batchSize) {
          const batchIndex = Math.floor(i / batchSize) + 1;
          const batch = updates.slice(i, i + batchSize);
          for (const u of batch) {
            successIds.push(u.id);
            results.push({ id: u.id, fields: u.fields });
          }
          options?.onBatch?.({
            batchIndex,
            totalBatches,
            batchSize: batch.length,
            successTotal: successIds.length,
            failedTotal: 0,
            retry: 0,
            durationMs: 1,
            status: "ok",
          });
        }
        return { results, successIds, failedBatchIndex: null, error: null };
      }
    );
    const updateRecordsBatched = vi.fn(async () => {
      throw new Error("updateRecordsBatched should not be used by applyAutoMatches");
    });

    return {
      listRecords,
      getRecord,
      updateRecordsBatched,
      updateRecordsBatchedDetailed,
      createRecords: vi.fn(),
      createRecordsBatched: vi.fn(),
      updateRecords: vi.fn(),
    } as unknown as AirtableClient & {
      listRecords: ReturnType<typeof vi.fn>;
      getRecord: ReturnType<typeof vi.fn>;
      updateRecordsBatched: ReturnType<typeof vi.fn>;
      updateRecordsBatchedDetailed: ReturnType<typeof vi.fn>;
    };
  }

  it("loads Airtable once for revalidation (not per candidate)", async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      autoRow(`rec${i}`, `u${i}@ex.com`, `cus_${i}`)
    );
    const snapshot = rows.map((r) => rec(r.airtableRecordId, r.airtableEmail));
    const airtable = mockAirtable(snapshot);
    const logs: string[] = [];

    const result = await applyAutoMatches({
      airtable,
      table: "Members",
      autoMatches: rows,
      log: (m) => logs.push(m),
      gapMs: 0,
    });

    expect(airtable.listRecords).toHaveBeenCalledTimes(1);
    expect(airtable.getRecord).not.toHaveBeenCalled();
    expect(result.listRecordsCalls).toBe(1);
    expect(result.getRecordCalls).toBe(0);
    expect(result.writesPerformed).toBe(25);
    expect(airtable.updateRecordsBatchedDetailed).toHaveBeenCalledTimes(1);
    const updates = airtable.updateRecordsBatchedDetailed.mock.calls[0][1] as Array<{
      id: string;
      fields: Record<string, unknown>;
    }>;
    expect(updates).toHaveLength(25);
    expect(updates.every((u) => Object.keys(u.fields).length === 1)).toBe(true);
    expect(
      updates.every((u) => STRIPE_CUSTOMER_ID_FIELD in u.fields)
    ).toBe(true);
  });

  it("does not call listRecords once per candidate", async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      autoRow(`rec${i}`, `u${i}@ex.com`, `cus_${i}`)
    );
    const airtable = mockAirtable(rows.map((r) => rec(r.airtableRecordId, r.airtableEmail)));
    await applyAutoMatches({
      airtable,
      table: "Members",
      autoMatches: rows,
      gapMs: 0,
    });
    expect(airtable.listRecords.mock.calls.length).toBe(1);
    expect(airtable.getRecord.mock.calls.length).toBe(0);
  });

  it("skips changed / duplicate / conflict records", async () => {
    const ok = autoRow("r_ok", "ok@ex.com", "cus_ok");
    const already = autoRow("r_set", "set@ex.com", "cus_set");
    const dup = autoRow("r_dup", "dup@ex.com", "cus_dup");
    const conflict = autoRow("r_c", "c@ex.com", "cus_taken");

    const snapshot = [
      rec("r_ok", "ok@ex.com"),
      rec("r_set", "set@ex.com", "cus_existing"),
      rec("r_dup", "dup@ex.com"),
      rec("r_dup2", "dup@ex.com"),
      rec("r_c", "c@ex.com"),
      rec("r_other", "other@ex.com", "cus_taken"),
    ];
    const airtable = mockAirtable(snapshot);
    const result = await applyAutoMatches({
      airtable,
      table: "Members",
      autoMatches: [ok, already, dup, conflict],
      gapMs: 0,
    });

    expect(result.skipped).toBe(3);
    expect(result.preparedUpdates).toHaveLength(1);
    expect(result.preparedUpdates[0].id).toBe("r_ok");
    expect(already.matchStatus).toBe("stripe_customer_id_already_set");
    expect(dup.matchStatus).toBe("duplicate_email_detected_before_apply");
    expect(conflict.matchStatus).toBe("stripe_customer_id_conflict_before_apply");
  });

  it("uses batches of 10", async () => {
    const rows = Array.from({ length: 23 }, (_, i) =>
      autoRow(`rec${i}`, `u${i}@ex.com`, `cus_${i}`)
    );
    const airtable = mockAirtable(rows.map((r) => rec(r.airtableRecordId, r.airtableEmail)));
    await applyAutoMatches({
      airtable,
      table: "Members",
      autoMatches: rows,
      batchSize: 10,
      gapMs: 0,
    });
    const opts = airtable.updateRecordsBatchedDetailed.mock.calls[0][2] as {
      batchSize: number;
    };
    expect(opts.batchSize).toBe(10);
  });

  it("emits progress logs", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      autoRow(`rec${i}`, `u${i}@ex.com`, `cus_${i}`)
    );
    const airtable = mockAirtable(rows.map((r) => rec(r.airtableRecordId, r.airtableEmail)));
    const logs: string[] = [];
    await applyAutoMatches({
      airtable,
      table: "Members",
      autoMatches: rows,
      log: (m) => logs.push(m),
      gapMs: 0,
    });
    expect(logs.some((l) => l.includes("Loading fresh Airtable snapshot"))).toBe(true);
    expect(logs.some((l) => l.includes("Fresh Airtable Members loaded"))).toBe(true);
    expect(logs.some((l) => l.includes("Revalidating"))).toBe(true);
    expect(logs.some((l) => l.includes("Valid updates after revalidation"))).toBe(true);
    expect(logs.some((l) => l.includes("Applying Airtable batches"))).toBe(true);
  });

  it("performWrites=false never calls update methods", async () => {
    const row = autoRow("r1", "a@ex.com", "cus_1");
    const airtable = mockAirtable([rec("r1", "a@ex.com")]);
    const result = await applyAutoMatches({
      airtable,
      table: "Members",
      autoMatches: [row],
      performWrites: false,
    });
    expect(result.preparedUpdates).toHaveLength(1);
    expect(result.writesPerformed).toBe(0);
    expect(airtable.updateRecordsBatchedDetailed).not.toHaveBeenCalled();
    expect(airtable.updateRecordsBatched).not.toHaveBeenCalled();
  });

  it("reports partial success when a later batch fails", async () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      autoRow(`rec${i}`, `u${i}@ex.com`, `cus_${i}`)
    );
    const airtable = mockAirtable(rows.map((r) => rec(r.airtableRecordId, r.airtableEmail)));
    airtable.updateRecordsBatchedDetailed.mockImplementation(
      async (
        _t: string,
        updates: Array<{ id: string }>,
        options?: { batchSize?: number; onBatch?: (i: {
          batchIndex: number;
          totalBatches: number;
          batchSize: number;
          successTotal: number;
          failedTotal: number;
          retry: number;
          durationMs: number;
          status: string;
          error?: string;
        }) => void }
      ) => {
        const batchSize = options?.batchSize ?? 10;
        const first = updates.slice(0, batchSize);
        options?.onBatch?.({
          batchIndex: 1,
          totalBatches: 2,
          batchSize: first.length,
          successTotal: first.length,
          failedTotal: 0,
          retry: 0,
          durationMs: 1,
          status: "ok",
        });
        options?.onBatch?.({
          batchIndex: 2,
          totalBatches: 2,
          batchSize: updates.length - batchSize,
          successTotal: first.length,
          failedTotal: updates.length - batchSize,
          retry: 0,
          durationMs: 1,
          status: "failed",
          error: "Airtable down",
        });
        return {
          results: first.map((u) => ({ id: u.id, fields: {} })),
          successIds: first.map((u) => u.id),
          failedBatchIndex: 2,
          error: new Error("Airtable down"),
        };
      }
    );

    const result = await applyAutoMatches({
      airtable,
      table: "Members",
      autoMatches: rows,
      gapMs: 0,
    });
    expect(result.successIds).toHaveLength(10);
    expect(result.failedBatchIndex).toBe(2);
    expect(result.error?.message).toContain("Airtable down");
    expect(result.writesPerformed).toBe(10);
  });

  it("rerun skips records already updated (already_set)", async () => {
    const row = autoRow("r1", "a@ex.com", "cus_1");
    // Snapshot already has the id from a previous successful apply
    const airtable = mockAirtable([rec("r1", "a@ex.com", "cus_1")]);
    const result = await applyAutoMatches({
      airtable,
      table: "Members",
      autoMatches: [row],
      gapMs: 0,
    });
    expect(result.skipped).toBe(1);
    expect(result.preparedUpdates).toHaveLength(0);
    expect(airtable.updateRecordsBatchedDetailed).not.toHaveBeenCalled();
    expect(row.matchStatus).toBe("stripe_customer_id_already_set");
  });
});

describe("toSnapshotMember", () => {
  it("normalizes email", () => {
    const m = toSnapshotMember({
      id: "r1",
      fields: { email: "  A@Ex.COM ", "Stripe Customer ID": "cus_x" },
    });
    expect(m.normalizedEmail).toBe("a@ex.com");
    expect(m.stripeCustomerId).toBe("cus_x");
  });
});
