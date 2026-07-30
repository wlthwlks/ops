/**
 * Backfill Airtable Members "Service access until" from paid Stripe invoices.
 *
 * Default is dry-run (no writes). Apply requires --apply.
 *
 *   npm run airtable:backfill-service-access
 *   npm run airtable:backfill-service-access -- --dry-run
 *   npm run airtable:backfill-service-access -- --apply
 *   npm run airtable:backfill-service-access -- --dry-run --stripe-customer-id=cus_xxx
 *   npm run airtable:backfill-service-access -- --dry-run --airtable-record-id=recXXX
 */
import * as dotenv from "dotenv";
import { createAirtableClient, type AirtableRecord } from "../src/lib/integrations/airtable";
import {
  getConfiguredMembershipPriceIds,
  getStripeClient,
} from "../src/lib/integrations/stripe";
import {
  MEMBERS_TABLE,
  SERVICE_ACCESS_FIELD,
  STRIPE_CUSTOMER_ID_FIELD,
  computeLatestMembershipPeriodEndForCustomer,
  escapeAirtableFormulaString,
  isValidStripeCustomerId,
  maxPaidThroughDate,
  type ServiceAccessRecordResult,
} from "../src/lib/billing/service-access-sync";

dotenv.config();

const CUSTOMER_CONCURRENCY = 4;

export function parseBackfillArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const dryRun = !apply;
  let limit: number | undefined;
  let airtableRecordId: string | undefined;
  let stripeCustomerId: string | undefined;

  for (const arg of argv) {
    if (arg.startsWith("--limit=")) {
      limit = parseInt(arg.slice("--limit=".length), 10);
    } else if (arg.startsWith("--airtable-record-id=")) {
      airtableRecordId = arg.slice("--airtable-record-id=".length).trim();
    } else if (arg.startsWith("--stripe-customer-id=")) {
      stripeCustomerId = arg.slice("--stripe-customer-id=".length).trim();
    }
  }

  return { apply, dryRun, limit, airtableRecordId, stripeCustomerId };
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

async function loadAirtableMembersForBackfill(input: {
  airtable: ReturnType<typeof createAirtableClient>;
  stripeCustomerId?: string;
  airtableRecordId?: string;
  limit?: number;
}): Promise<{ allScanned: number; members: AirtableRecord[] }> {
  const { airtable, stripeCustomerId, airtableRecordId, limit } = input;

  // Single Airtable record path — no full Members scan
  if (airtableRecordId) {
    console.log(`Fetching Airtable record ${airtableRecordId}...`);
    const rec = await airtable.getRecord(MEMBERS_TABLE, airtableRecordId);
    return { allScanned: 1, members: [rec] };
  }

  // Single Stripe customer — formula filter only that customer
  if (stripeCustomerId) {
    if (!isValidStripeCustomerId(stripeCustomerId)) {
      throw new Error(`Invalid --stripe-customer-id value: ${stripeCustomerId}`);
    }
    const escaped = escapeAirtableFormulaString(stripeCustomerId);
    console.log(`Fetching Airtable Members for ${stripeCustomerId}...`);
    const members = await airtable.listRecords(MEMBERS_TABLE, {
      fields: [STRIPE_CUSTOMER_ID_FIELD, SERVICE_ACCESS_FIELD, "Name"],
      filterByFormula: `{${STRIPE_CUSTOMER_ID_FIELD}} = "${escaped}"`,
    });
    return { allScanned: members.length, members };
  }

  // Full backfill — members with non-empty Stripe Customer ID
  console.log("Fetching Airtable Members with Stripe Customer ID...");
  let members = await airtable.listRecords(MEMBERS_TABLE, {
    fields: [STRIPE_CUSTOMER_ID_FIELD, SERVICE_ACCESS_FIELD, "Name"],
    filterByFormula: `AND({${STRIPE_CUSTOMER_ID_FIELD}} != "", {${STRIPE_CUSTOMER_ID_FIELD}} != BLANK())`,
  });
  const allScanned = members.length;
  if (limit && limit > 0) {
    members = members.slice(0, limit);
  }
  return { allScanned, members };
}

async function main() {
  const args = parseBackfillArgs(process.argv.slice(2));
  const modeLabel = args.dryRun ? "DRY-RUN" : "APPLY";
  console.log(`Mode: ${modeLabel}`);
  console.log(`Writes performed: 0 (pending)\n`);

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

  const { allScanned, members } = await loadAirtableMembersForBackfill({
    airtable,
    stripeCustomerId: args.stripeCustomerId,
    airtableRecordId: args.airtableRecordId,
    limit: args.limit,
  });

  // If airtable-record-id path, resolve stripe customer from the record
  if (args.airtableRecordId && members[0]) {
    const cus = String(members[0].fields[STRIPE_CUSTOMER_ID_FIELD] || "").trim();
    if (!isValidStripeCustomerId(cus)) {
      console.error(
        `Airtable record ${args.airtableRecordId} has no valid Stripe Customer ID (got: ${cus || "blank"})`
      );
      process.exit(1);
    }
    // Force single-customer stripe path via map below
  }

  const customerToRecords = new Map<string, AirtableRecord[]>();
  for (const rec of members) {
    const cus = String(rec.fields[STRIPE_CUSTOMER_ID_FIELD] || "").trim();
    if (!isValidStripeCustomerId(cus)) continue;
    const list = customerToRecords.get(cus) || [];
    list.push(rec);
    customerToRecords.set(cus, list);
  }

  if (args.stripeCustomerId && customerToRecords.size === 0) {
    console.error(`No Airtable Members found for Stripe Customer ID ${args.stripeCustomerId}`);
    process.exit(1);
  }

  const customerIds = Array.from(customerToRecords.keys());
  console.log(`Airtable members scanned: ${allScanned}`);
  console.log(`Members in scope: ${members.length}`);
  console.log(`Unique Stripe customers: ${customerIds.length}`);
  console.log(`Membership price IDs: ${membershipPriceIds.size}\n`);

  const customerPaidThrough = new Map<string, number>();
  let paidInvoicesScanned = 0;
  let qualifyingInvoices = 0;
  let qualifyingLines = 0;
  let lineRequests = 0;
  let stripeErrors = 0;
  const singleCustomer = customerIds.length === 1;

  const concurrency = singleCustomer ? 1 : CUSTOMER_CONCURRENCY;
  console.log(
    singleCustomer
      ? `Single-customer mode — listing paid invoices for ${customerIds[0]} only\n`
      : `Full backfill — per-customer invoice list (concurrency ${concurrency})\n`
  );

  await mapPool(customerIds, concurrency, async (cusId, index) => {
    try {
      if (singleCustomer) {
        console.log(`Fetching paid Stripe invoices for ${cusId}`);
      }

      const result = await computeLatestMembershipPeriodEndForCustomer(
        stripe,
        cusId,
        membershipPriceIds,
        {
          onInvoicePage: singleCustomer
            ? (page, pageCount, total) => {
                console.log(`Stripe invoice page ${page}: ${pageCount} invoices (total ${total})`);
              }
            : undefined,
          onInvoice: singleCustomer
            ? (i, total, invoiceId) => {
                console.log(`Inspecting invoice ${i}/${total}: ${invoiceId}`);
              }
            : undefined,
        }
      );

      paidInvoicesScanned += result.invoicesInspected;
      qualifyingInvoices += result.qualifyingInvoices;
      qualifyingLines += result.qualifyingLines;
      lineRequests += result.lineRequests;

      if (singleCustomer) {
        console.log(`Paid invoices found: ${result.invoicesInspected}`);
        console.log(`Qualifying membership invoices: ${result.qualifyingInvoices}`);
        console.log(`Qualifying membership lines: ${result.qualifyingLines}`);
        if (result.periodEndUnix != null) {
          console.log(
            `Latest paid-through date: ${new Date(result.periodEndUnix * 1000).toISOString()}`
          );
        } else {
          console.log("Latest paid-through date: (none — no qualifying membership lines)");
        }
        console.log("");
      }

      if (result.periodEndUnix != null) {
        customerPaidThrough.set(cusId, result.periodEndUnix);
      }
    } catch (err) {
      stripeErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          event: "backfill_customer_error",
          stripeCustomerId: cusId,
          error: msg,
        })
      );
      if (singleCustomer) {
        console.error(`Stripe error for ${cusId}: ${msg}`);
        process.exit(1);
      }
    }

    if (!singleCustomer && (index + 1) % 10 === 0) {
      console.log(`Processed Stripe customers: ${index + 1}/${customerIds.length}`);
    }
  });

  if (!singleCustomer && customerIds.length > 0) {
    console.log(`Processed Stripe customers: ${customerIds.length}/${customerIds.length}\n`);
  }

  const planned: ServiceAccessRecordResult[] = [];
  let wouldUpdate = 0;
  let alreadyUpToDate = 0;
  let existingLater = 0;
  let invalidDates = 0;
  let noQualifying = 0;
  let duplicates = 0;

  for (const [cusId, records] of customerToRecords) {
    if (records.length > 1) duplicates++;
    const endUnix = customerPaidThrough.get(cusId);
    if (endUnix == null) {
      noQualifying++;
      continue;
    }
    for (const rec of records) {
      const oldRaw = rec.fields[SERVICE_ACCESS_FIELD];
      const oldValue = oldRaw == null || oldRaw === "" ? null : String(oldRaw);
      const comparison = maxPaidThroughDate(oldRaw as string | null, endUnix);
      if (comparison.invalidCurrent) {
        invalidDates++;
        planned.push({
          airtableRecordId: rec.id,
          stripeCustomerId: cusId,
          oldValue,
          newValue: null,
          status: "invalid_existing_date",
          reason: comparison.reason,
          updated: false,
        });
        continue;
      }
      if (!comparison.shouldUpdate) {
        if (comparison.reason === "Already up to date") alreadyUpToDate++;
        else existingLater++;
        planned.push({
          airtableRecordId: rec.id,
          stripeCustomerId: cusId,
          oldValue,
          newValue: comparison.finalDate.toISOString(),
          status:
            comparison.reason === "Already up to date"
              ? "already_up_to_date"
              : "existing_later",
          reason: comparison.reason,
          updated: false,
        });
        continue;
      }
      wouldUpdate++;
      planned.push({
        airtableRecordId: rec.id,
        stripeCustomerId: cusId,
        oldValue,
        newValue: comparison.finalDate.toISOString(),
        status: "updated",
        reason: comparison.reason,
        updated: !args.dryRun,
      });
    }
  }

  console.log("--- Planned rows (updates / invalid) ---");
  for (const row of planned.filter(
    (p) => p.status === "updated" || p.status === "invalid_existing_date"
  )) {
    console.log(
      `  ${row.airtableRecordId} | ${row.stripeCustomerId} | old=${row.oldValue ?? "(blank)"} | new=${row.newValue ?? "—"} | ${row.reason}`
    );
  }

  let airtableUpdated = 0;
  let airtableErrors = 0;
  let writesPerformed = 0;

  // Final apply guard — immediately before any Airtable write
  if (!args.dryRun) {
    const updates = planned
      .filter((p) => p.status === "updated" && p.newValue)
      .map((p) => ({
        id: p.airtableRecordId,
        fields: { [SERVICE_ACCESS_FIELD]: p.newValue as string },
      }));
    console.log(`\nApplying ${updates.length} Airtable update(s)...`);
    try {
      if (updates.length > 0) {
        await airtable.updateRecordsBatched(MEMBERS_TABLE, updates);
        airtableUpdated = updates.length;
        writesPerformed = updates.length;
      }
    } catch (err) {
      airtableErrors++;
      console.error("Airtable update failed:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  }

  console.log("\n========== SUMMARY ==========");
  console.log(`Mode: ${modeLabel}`);
  console.log(`Writes performed: ${writesPerformed}`);
  console.log(`Airtable members scanned: ${allScanned}`);
  console.log(`Members in scope: ${members.length}`);
  console.log(`Unique Stripe customers: ${customerIds.length}`);
  console.log(`Paid Stripe invoices inspected: ${paidInvoicesScanned}`);
  console.log(`Invoice line requests: ${lineRequests}`);
  console.log(`Qualifying membership invoices: ${qualifyingInvoices}`);
  console.log(`Qualifying membership lines: ${qualifyingLines}`);
  console.log(`Customers with calculated paid-through: ${customerPaidThrough.size}`);
  console.log(`Airtable records that would be updated: ${wouldUpdate}`);
  console.log(`Airtable records updated: ${airtableUpdated}`);
  console.log(`Already up to date: ${alreadyUpToDate}`);
  console.log(`Existing later dates preserved: ${existingLater}`);
  console.log(`Customers with no qualifying paid invoice: ${noQualifying}`);
  console.log(`Invalid Airtable dates: ${invalidDates}`);
  console.log(`Duplicate Airtable customer mappings: ${duplicates}`);
  console.log(`Stripe errors: ${stripeErrors}`);
  console.log(`Airtable errors: ${airtableErrors}`);
  console.log("=============================\n");

  if (args.dryRun) {
    console.log("Mode: DRY-RUN");
    console.log("Writes performed: 0");
  }

  if (stripeErrors > 0) process.exitCode = 1;
}

const isDirectRun =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("backfill-service-access-until.ts") ||
    process.argv[1].endsWith("backfill-service-access-until.js"));

if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
