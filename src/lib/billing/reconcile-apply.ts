/**
 * Apply-stage helpers for Stripe Customer ID reconciliation.
 * One Airtable snapshot + in-memory revalidation + throttled batched writes.
 * Never used for dry-run writes.
 */
import type { AirtableClient, AirtableRecord } from "@/lib/integrations/airtable";
import {
  type ReconcileMatchStatus,
  type ReconcileRow,
  normalizeEmailStrict,
} from "@/lib/billing/reconcile-stripe-customers";
import { STRIPE_CUSTOMER_ID_FIELD } from "@/lib/billing/service-access-sync";

export const PRIMARY_EMAIL_FIELD = "email";

export type SnapshotMember = {
  recordId: string;
  email: string;
  normalizedEmail: string;
  stripeCustomerId: string;
};

export type ApplySkipStatus =
  | "record_changed_before_apply"
  | "email_changed_before_apply"
  | "stripe_customer_id_already_set"
  | "duplicate_email_detected_before_apply"
  | "stripe_customer_id_conflict_before_apply"
  | "record_missing_before_apply";

export type ApplyRevalidateResult =
  | { ok: true; update: { id: string; fields: Record<string, unknown> } }
  | { ok: false; status: ApplySkipStatus; reason: string };

export type FreshSnapshotMaps = {
  byRecordId: Map<string, SnapshotMember>;
  byNormalizedEmail: Map<string, SnapshotMember[]>;
  byStripeCustomerId: Map<string, SnapshotMember[]>;
  totalRecords: number;
};

export function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  return String(v).trim();
}

export function toSnapshotMember(record: AirtableRecord): SnapshotMember {
  const email = fieldStr(record.fields, PRIMARY_EMAIL_FIELD);
  return {
    recordId: record.id,
    email,
    normalizedEmail: email ? normalizeEmailStrict(email) : "",
    stripeCustomerId: fieldStr(record.fields, STRIPE_CUSTOMER_ID_FIELD),
  };
}

export function buildFreshSnapshotMaps(records: AirtableRecord[]): FreshSnapshotMaps {
  const byRecordId = new Map<string, SnapshotMember>();
  const byNormalizedEmail = new Map<string, SnapshotMember[]>();
  const byStripeCustomerId = new Map<string, SnapshotMember[]>();

  for (const rec of records) {
    const m = toSnapshotMember(rec);
    byRecordId.set(m.recordId, m);

    if (m.normalizedEmail) {
      const list = byNormalizedEmail.get(m.normalizedEmail) || [];
      list.push(m);
      byNormalizedEmail.set(m.normalizedEmail, list);
    }

    const cus = m.stripeCustomerId;
    if (cus.startsWith("cus_")) {
      const list = byStripeCustomerId.get(cus) || [];
      list.push(m);
      byStripeCustomerId.set(cus, list);
    }
  }

  return {
    byRecordId,
    byNormalizedEmail,
    byStripeCustomerId,
    totalRecords: records.length,
  };
}

/**
 * Revalidate one auto_match row against a fresh in-memory snapshot.
 * No network I/O.
 */
export function revalidateAutoMatchAgainstSnapshot(
  row: ReconcileRow,
  maps: FreshSnapshotMaps,
  reservedCustomerIds: Set<string>
): ApplyRevalidateResult {
  if (row.matchStatus !== "auto_match" || !row.suggestedStripeCustomerId.startsWith("cus_")) {
    return {
      ok: false,
      status: "record_changed_before_apply",
      reason: "Row is not an auto_match with a suggested customer id",
    };
  }

  const fresh = maps.byRecordId.get(row.airtableRecordId);
  if (!fresh) {
    return {
      ok: false,
      status: "record_missing_before_apply",
      reason: "Airtable record no longer exists",
    };
  }

  if (fresh.stripeCustomerId.startsWith("cus_")) {
    return {
      ok: false,
      status: "stripe_customer_id_already_set",
      reason: "Stripe Customer ID already set on record",
    };
  }

  const expectedEmail = normalizeEmailStrict(row.airtableEmail);
  if (fresh.normalizedEmail !== expectedEmail) {
    return {
      ok: false,
      status: "email_changed_before_apply",
      reason: "Primary email changed before apply",
    };
  }

  const emailOwners = maps.byNormalizedEmail.get(fresh.normalizedEmail) || [];
  if (emailOwners.length !== 1) {
    return {
      ok: false,
      status: "duplicate_email_detected_before_apply",
      reason: `Expected exactly one Airtable record for email, found ${emailOwners.length}`,
    };
  }

  if (emailOwners[0].recordId !== row.airtableRecordId) {
    return {
      ok: false,
      status: "duplicate_email_detected_before_apply",
      reason: "Email ownership no longer matches this record",
    };
  }

  const suggested = row.suggestedStripeCustomerId;
  const holders = maps.byStripeCustomerId.get(suggested) || [];
  const otherHolders = holders.filter((h) => h.recordId !== row.airtableRecordId);
  if (otherHolders.length > 0 || reservedCustomerIds.has(suggested)) {
    return {
      ok: false,
      status: "stripe_customer_id_conflict_before_apply",
      reason: "Suggested Stripe Customer ID is assigned elsewhere",
    };
  }

  return {
    ok: true,
    update: {
      id: row.airtableRecordId,
      fields: { [STRIPE_CUSTOMER_ID_FIELD]: suggested },
    },
  };
}

export type ApplyAutoMatchesResult = {
  /** Updates that passed local revalidation. */
  preparedUpdates: Array<{ id: string; fields: Record<string, unknown> }>;
  skipped: number;
  /** Successfully written record ids. */
  successIds: string[];
  failedBatchIndex: number | null;
  error: Error | null;
  /** listRecords calls made during apply (should be 1). */
  listRecordsCalls: number;
  /** getRecord calls made during apply (should be 0). */
  getRecordCalls: number;
  writesPerformed: number;
};

export type ApplyLogger = (message: string) => void;

/**
 * Apply auto_match rows:
 * 1. One fresh Members snapshot (email + Stripe Customer ID only)
 * 2. In-memory revalidation
 * 3. Throttled batched PATCH (batches of 10)
 *
 * Dry-run must never call this. Script must gate with !dryRun before invoke.
 */
export async function applyAutoMatches(input: {
  airtable: AirtableClient;
  table: string;
  autoMatches: ReconcileRow[];
  /** Mutates row statuses when skipping / marking updated. */
  rowsByRecordId?: Map<string, ReconcileRow>;
  log?: ApplyLogger;
  batchSize?: number;
  gapMs?: number;
  /** When false, prepare updates but do not call updateRecordsBatched. */
  performWrites?: boolean;
}): Promise<ApplyAutoMatchesResult> {
  const {
    airtable,
    table,
    autoMatches,
    rowsByRecordId,
    log = () => {},
    batchSize = 10,
    gapMs = 250,
    performWrites = true,
  } = input;

  let listRecordsCalls = 0;
  const getRecordCalls = 0;

  log("Loading fresh Airtable snapshot...");
  const snapStarted = Date.now();
  // Single full-table read for revalidation — never per candidate.
  const freshRecords = await airtable.listRecords(table, {
    fields: [PRIMARY_EMAIL_FIELD, STRIPE_CUSTOMER_ID_FIELD],
  });
  listRecordsCalls = 1;
  log(
    `Fresh Airtable Members loaded: ${freshRecords.length} (${Date.now() - snapStarted}ms)`
  );

  const maps = buildFreshSnapshotMaps(freshRecords);
  const reservedCustomerIds = new Set<string>();
  const preparedUpdates: Array<{ id: string; fields: Record<string, unknown> }> = [];
  let skipped = 0;

  log(`Revalidating ${autoMatches.length} candidates locally...`);
  for (let i = 0; i < autoMatches.length; i++) {
    const row = autoMatches[i];
    const result = revalidateAutoMatchAgainstSnapshot(row, maps, reservedCustomerIds);
    if (!result.ok) {
      skipped++;
      row.matchStatus = result.status as ReconcileMatchStatus;
      row.reason = result.reason;
      row.wouldUpdate = false;
      row.updated = false;
      const live = rowsByRecordId?.get(row.airtableRecordId);
      if (live && live !== row) {
        live.matchStatus = result.status as ReconcileMatchStatus;
        live.reason = result.reason;
        live.wouldUpdate = false;
        live.updated = false;
      }
    } else {
      preparedUpdates.push(result.update);
      reservedCustomerIds.add(row.suggestedStripeCustomerId);
    }

    const n = i + 1;
    if (n % 1000 === 0 || n === autoMatches.length) {
      log(`Revalidated: ${n}/${autoMatches.length}`);
    }
  }

  log(`Valid updates after revalidation: ${preparedUpdates.length}`);
  log(`Skipped because records changed: ${skipped}`);

  if (!performWrites) {
    return {
      preparedUpdates,
      skipped,
      successIds: [],
      failedBatchIndex: null,
      error: null,
      listRecordsCalls,
      getRecordCalls,
      writesPerformed: 0,
    };
  }

  if (preparedUpdates.length === 0) {
    log("No Airtable updates to apply.");
    return {
      preparedUpdates,
      skipped,
      successIds: [],
      failedBatchIndex: null,
      error: null,
      listRecordsCalls,
      getRecordCalls,
      writesPerformed: 0,
    };
  }

  // Final write guard: only Stripe Customer ID field, only when performWrites.
  const totalBatches = Math.ceil(preparedUpdates.length / batchSize);
  log(`Applying Airtable batches: 0/${totalBatches} (batch size ${batchSize})`);

  const writeResult = await airtable.updateRecordsBatchedDetailed(table, preparedUpdates, {
    batchSize,
    gapMs,
    onBatch: (info) => {
      const every =
        info.batchIndex % 10 === 0 ||
        info.batchIndex === info.totalBatches ||
        info.batchIndex === 1;
      if (every || info.status !== "ok") {
        log(
          `Applying Airtable batches: ${info.batchIndex}/${info.totalBatches} ` +
            `size=${info.batchSize} success=${info.successTotal} failed=${info.failedTotal} ` +
            `retry=${info.retry} durationMs=${info.durationMs}` +
            (info.error ? ` error=${info.error.slice(0, 120)}` : "")
        );
        log(`Updated records: ${info.successTotal}/${preparedUpdates.length}`);
      }
    },
  });

  // Mark successful rows
  const successSet = new Set(writeResult.successIds);
  for (const row of autoMatches) {
    if (successSet.has(row.airtableRecordId)) {
      row.updated = true;
      const live = rowsByRecordId?.get(row.airtableRecordId);
      if (live) live.updated = true;
    }
  }

  if (writeResult.error) {
    log(
      `Apply stopped after batch ${writeResult.failedBatchIndex}: ${writeResult.error.message}`
    );
    log(`Partial success: ${writeResult.successIds.length} record(s) updated before failure`);
  } else {
    log(
      `Apply complete: ${writeResult.successIds.length}/${preparedUpdates.length} records updated`
    );
  }

  return {
    preparedUpdates,
    skipped,
    successIds: writeResult.successIds,
    failedBatchIndex: writeResult.failedBatchIndex,
    error: writeResult.error,
    listRecordsCalls,
    getRecordCalls,
    writesPerformed: writeResult.successIds.length,
  };
}
