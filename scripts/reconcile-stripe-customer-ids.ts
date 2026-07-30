/**
 * Reconcile missing Airtable "Stripe Customer ID" via strict email match + billing history.
 *
 * Dry-run by default. Writes only with --apply, and only auto_match rows.
 *
 *   npm run airtable:reconcile-stripe-customers -- --dry-run
 *   npm run airtable:reconcile-stripe-customers -- --apply
 *   npm run airtable:reconcile-stripe-customers -- --dry-run --email=person@example.com
 */
import * as dotenv from "dotenv";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import {
  getConfiguredMembershipPriceIds,
  getStripeClient,
} from "../src/lib/integrations/stripe";
import {
  MEMBERS_TABLE,
  SERVICE_ACCESS_FIELD,
  STRIPE_CUSTOMER_ID_FIELD,
  computeLatestMembershipPeriodEndForCustomer,
} from "../src/lib/billing/service-access-sync";
import {
  type AirtableMemberCandidate,
  type ReconcileRow,
  type StripeCustomerCandidate,
  buildAssignedCustomerIds,
  classifyCandidate,
  groupByNormalizedEmail,
  isManualReviewStatus,
  isValidEmail,
  maskEmail,
  normalizeEmailStrict,
  parseReconcileArgs,
  rowsToCsv,
} from "../src/lib/billing/reconcile-stripe-customers";
import { applyAutoMatches } from "../src/lib/billing/reconcile-apply";

dotenv.config();

const VALIDATE_CONCURRENCY = 4;

export { parseReconcileArgs };

function reportPathForFailure(output: string): string {
  return output.replace(/\.csv$/i, "-apply-failure.csv");
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  return String(v).trim();
}

async function main() {
  const args = parseReconcileArgs(process.argv.slice(2));
  const modeLabel = args.dryRun ? "DRY-RUN — no Airtable writes" : "APPLY — Airtable writes enabled";
  console.log(`Mode: ${modeLabel}\n`);

  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    console.error("Missing AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID");
    process.exit(1);
  }

  let membershipPriceIds: Set<string>;
  try {
    membershipPriceIds = getConfiguredMembershipPriceIds({ requireConfigured: true });
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  const stripe = getStripeClient();
  const airtable = createAirtableClient({ apiKey: token, baseId });

  // ── Step 1: Airtable ──
  console.log("Loading Airtable Members...");
  let allRecords;
  try {
    allRecords = await airtable.listRecords(MEMBERS_TABLE, {
      fields: ["Name", "email", "Slack Email", STRIPE_CUSTOMER_ID_FIELD, SERVICE_ACCESS_FIELD],
    });
  } catch (e) {
    console.error("Airtable list failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  let candidates: AirtableMemberCandidate[] = allRecords.map((r) => {
    const email = fieldStr(r.fields, "email");
    return {
      recordId: r.id,
      name: fieldStr(r.fields, "Name"),
      email,
      normalizedEmail: email ? normalizeEmailStrict(email) : "",
      slackEmail: fieldStr(r.fields, "Slack Email"),
      existingStripeCustomerId: fieldStr(r.fields, STRIPE_CUSTOMER_ID_FIELD),
      serviceAccessUntil: fieldStr(r.fields, SERVICE_ACCESS_FIELD),
    };
  });

  if (args.airtableRecordId) {
    candidates = candidates.filter((c) => c.recordId === args.airtableRecordId);
  }
  if (args.email) {
    const want = normalizeEmailStrict(args.email);
    candidates = candidates.filter(
      (c) =>
        c.normalizedEmail === want ||
        normalizeEmailStrict(c.slackEmail) === want
    );
  }
  if (args.limit && args.limit > 0) {
    candidates = candidates.slice(0, args.limit);
  }

  const alreadyHasId = candidates.filter((c) =>
    c.existingStripeCustomerId.startsWith("cus_")
  ).length;
  const missingId = candidates.filter((c) => !c.existingStripeCustomerId.startsWith("cus_"));
  const missingPrimaryEmail = missingId.filter((c) => !c.email.trim()).length;

  // Emails that need reconciliation (missing customer id + valid primary email)
  const needingEmail = missingId.filter((c) => c.normalizedEmail && isValidEmail(c.email));
  const emailsNeeding = new Set(needingEmail.map((c) => c.normalizedEmail));

  console.log(`Airtable Members scanned: ${allRecords.length}`);
  console.log(`Members already containing Stripe Customer ID: ${alreadyHasId}`);
  console.log(`Members missing Stripe Customer ID: ${missingId.length}`);
  console.log(`Members missing primary email: ${missingPrimaryEmail}`);
  console.log(`Unique missing-member emails: ${emailsNeeding.size}\n`);

  const assignedIds = buildAssignedCustomerIds(
    allRecords.map((r) => ({
      existingStripeCustomerId: fieldStr(r.fields, STRIPE_CUSTOMER_ID_FIELD),
    }))
  );

  const airtableByEmail = groupByNormalizedEmail(candidates);

  // ── Step 2: Stripe customers ──
  console.log("Listing Stripe customers...");
  const stripeByEmail = new Map<string, StripeCustomerCandidate[]>();
  let stripeCustomersScanned = 0;
  let relevantStripeMatches = 0;

  try {
    for await (const customer of stripe.customers.list({ limit: 100 })) {
      stripeCustomersScanned++;
      if (stripeCustomersScanned % 100 === 0) {
        console.log(`Stripe customers scanned: ${stripeCustomersScanned}`);
      }

      if (customer.deleted) continue;
      const email = (customer.email || "").trim();
      if (!email) continue;
      const normalizedEmail = normalizeEmailStrict(email);
      if (!emailsNeeding.has(normalizedEmail)) continue;

      const cand: StripeCustomerCandidate = {
        id: customer.id,
        email,
        normalizedEmail,
        created: customer.created ?? 0,
        livemode: customer.livemode ?? false,
      };
      const list = stripeByEmail.get(normalizedEmail) || [];
      list.push(cand);
      stripeByEmail.set(normalizedEmail, list);
      relevantStripeMatches++;
    }
  } catch (e) {
    console.error("Stripe customer list failed:", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.log(`Stripe customers scanned: ${stripeCustomersScanned}`);
  console.log(`Relevant Stripe email matches found: ${relevantStripeMatches}\n`);

  // ── Step 3: one-to-one candidates → billing validation ──
  type Pending = {
    member: AirtableMemberCandidate;
    airtableCount: number;
    stripeList: StripeCustomerCandidate[];
  };

  const pendingValidate: Pending[] = [];
  const rows: ReconcileRow[] = [];

  for (const member of candidates) {
    const airtableCount = member.normalizedEmail
      ? airtableByEmail.get(member.normalizedEmail)?.length ?? 0
      : 0;
    const stripeList = member.normalizedEmail
      ? stripeByEmail.get(member.normalizedEmail) || []
      : [];

    // Early classify without billing when not a unique 1:1 candidate
    const early = classifyCandidate({
      member,
      airtableRecordsForEmail: airtableCount || 1,
      stripeCandidates: stripeList,
      assignedElsewhere: assignedIds,
      // no billing yet — will reclassify if 1:1
    });

    const isOneToOne =
      !member.existingStripeCustomerId.startsWith("cus_") &&
      isValidEmail(member.email) &&
      airtableCount === 1 &&
      stripeList.length === 1 &&
      !assignedIds.has(stripeList[0].id);

    if (isOneToOne) {
      pendingValidate.push({ member, airtableCount, stripeList });
    } else {
      rows.push(early);
    }
  }

  console.log(`Validating billing history for ${pendingValidate.length} one-to-one candidates...`);
  let validated = 0;

  await mapPool(pendingValidate, VALIDATE_CONCURRENCY, async (item) => {
    const stripeCustomerId = item.stripeList[0].id;
    let billing: {
      ok: boolean;
      error?: string;
      hasPaidInvoices: boolean;
      hasQualifyingMembership: boolean;
      latestPaidThroughIso: string | null;
      periodValid: boolean;
    };

    try {
      const result = await computeLatestMembershipPeriodEndForCustomer(
        stripe,
        stripeCustomerId,
        membershipPriceIds
      );
      billing = {
        ok: true,
        hasPaidInvoices: result.invoicesInspected > 0,
        hasQualifyingMembership: result.periodEndUnix != null && result.qualifyingLines > 0,
        latestPaidThroughIso:
          result.periodEndUnix != null
            ? new Date(result.periodEndUnix * 1000).toISOString()
            : null,
        periodValid: result.periodEndUnix != null,
      };
    } catch (err) {
      billing = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        hasPaidInvoices: false,
        hasQualifyingMembership: false,
        latestPaidThroughIso: null,
        periodValid: false,
      };
    }

    const row = classifyCandidate({
      member: item.member,
      airtableRecordsForEmail: item.airtableCount,
      stripeCandidates: item.stripeList,
      assignedElsewhere: assignedIds,
      billing,
    });
    rows.push(row);

    validated++;
    if (validated % 10 === 0 || validated === pendingValidate.length) {
      console.log(`Validated billing history: ${validated}/${pendingValidate.length}`);
    }
    return row;
  });

  // Stable sort by status then email
  rows.sort((a, b) =>
    a.matchStatus.localeCompare(b.matchStatus) ||
    a.airtableEmail.localeCompare(b.airtableEmail)
  );

  // ── Counts ──
  const count = (s: string) => rows.filter((r) => r.matchStatus === s).length;
  const autoMatches = rows.filter((r) => r.matchStatus === "auto_match");
  const wouldUpdate = autoMatches.length;

  // ── Apply ──
  // Dry-run never enters this block (zero writes).
  let airtableUpdated = 0;
  let changedBeforeApply = 0;
  let airtableErrors = 0;
  let writesPerformed = 0;

  // parseReconcileArgs: dryRun is false only when --apply is present.
  if (!args.dryRun) {
    console.log(`\nApplying ${autoMatches.length} auto_match update(s)...`);
    console.log(
      "Revalidation uses ONE fresh Members snapshot (no per-candidate getRecord).\n"
    );

    const rowsByRecordId = new Map(rows.map((r) => [r.airtableRecordId, r]));

    try {
      // Write guard: only reached with --apply. Only field written: Stripe Customer ID.
      const applyResult = await applyAutoMatches({
        airtable,
        table: MEMBERS_TABLE,
        autoMatches,
        rowsByRecordId,
        log: (msg) => console.log(msg),
        batchSize: 10,
        gapMs: 250,
        performWrites: true,
      });

      changedBeforeApply = applyResult.skipped;
      airtableUpdated = applyResult.writesPerformed;
      writesPerformed = applyResult.writesPerformed;

      if (applyResult.error) {
        airtableErrors++;
        process.exitCode = 1;
        const failPath = reportPathForFailure(args.output);
        mkdirSync(dirname(failPath), { recursive: true });
        writeFileSync(
          failPath,
          rowsToCsv(rows) +
            `\n# partial_success=${applyResult.successIds.length}` +
            `\n# failed_batch=${applyResult.failedBatchIndex}` +
            `\n# error=${applyResult.error.message}\n`,
          "utf8"
        );
        console.error(`Failure report: ${failPath}`);
      }

      console.log(
        `Apply Airtable reads: listRecords=${applyResult.listRecordsCalls} getRecord=${applyResult.getRecordCalls}`
      );
    } catch (err) {
      airtableErrors++;
      console.error("Apply failed:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  } else if (!args.dryRun) {
    // Safety: never write without explicit --apply
    console.log("Skipping writes (apply flag not set).");
  }

  // ── Reports ──
  const reportPath = args.output;
  const manualPath = reportPath.replace(/\.csv$/i, "-manual-review.csv");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, rowsToCsv(rows), "utf8");

  const manualRows = rows.filter(
    (r) =>
      isManualReviewStatus(r.matchStatus) &&
      (r.candidateStripeCustomerIds.length > 0 ||
        r.matchStatus === "duplicate_airtable_email" ||
        r.matchStatus === "multiple_stripe_customers" ||
        r.matchStatus === "slack_email_only")
  );
  writeFileSync(manualPath, rowsToCsv(manualRows), "utf8");

  console.log("\n========== SUMMARY ==========");
  console.log(`Mode: ${args.dryRun ? "DRY-RUN" : "APPLY"}`);
  console.log(`Writes performed: ${writesPerformed}`);
  console.log(`Airtable Members scanned: ${allRecords.length}`);
  console.log(`Members already containing Stripe Customer ID: ${alreadyHasId}`);
  console.log(`Members missing Stripe Customer ID: ${missingId.length}`);
  console.log(`Members missing primary email: ${missingPrimaryEmail}`);
  console.log(`Unique Airtable emails requiring reconciliation: ${emailsNeeding.size}`);
  console.log(`Stripe customers scanned: ${stripeCustomersScanned}`);
  console.log(`Relevant Stripe customers found: ${relevantStripeMatches}`);
  console.log(`Automatic one-to-one matches: ${count("auto_match")}`);
  console.log(`Duplicate Airtable emails: ${count("duplicate_airtable_email")}`);
  console.log(`Multiple Stripe customers for one email: ${count("multiple_stripe_customers")}`);
  console.log(
    `Stripe customer IDs already assigned elsewhere: ${count("stripe_customer_already_assigned")}`
  );
  console.log(`Customers without paid invoices: ${count("no_paid_invoices")}`);
  console.log(
    `Customers without qualifying membership invoices: ${count("no_qualifying_membership_invoice")}`
  );
  console.log(`Slack-email-only records: ${count("slack_email_only")}`);
  console.log(
    `Unresolved (no_stripe / invalid / errors / missing email): ${
      count("no_stripe_customer") +
      count("invalid_airtable_email") +
      count("missing_airtable_email") +
      count("stripe_error") +
      count("airtable_error") +
      count("invalid_invoice_period")
    }`
  );
  console.log(`Airtable records that would be updated: ${wouldUpdate}`);
  console.log(`Airtable records updated: ${airtableUpdated}`);
  console.log(`Records changed before apply: ${changedBeforeApply}`);
  console.log(`Stripe errors: ${count("stripe_error")}`);
  console.log(`Airtable errors: ${airtableErrors + count("airtable_error")}`);
  console.log(`Report path: ${reportPath}`);
  console.log(`Manual review path: ${manualPath}`);
  console.log("=============================\n");

  if (args.dryRun) {
    console.log("Mode: DRY-RUN — no Airtable writes");
    console.log("Writes performed: 0");
  }

  // Sample auto matches (masked)
  const sample = autoMatches.slice(0, 10);
  if (sample.length > 0) {
    console.log("Sample auto_match (masked emails):");
    for (const r of sample) {
      console.log(
        `  ${r.airtableRecordId} | ${maskEmail(r.airtableEmail)} → ${r.suggestedStripeCustomerId} | through ${r.latestQualifyingPaidThrough || "—"}`
      );
    }
  }

  if (airtableErrors > 0) process.exitCode = 1;
}

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("reconcile-stripe-customer-ids.ts") ||
    process.argv[1].endsWith("reconcile-stripe-customer-ids.js"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
