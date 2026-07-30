/**
 * ONE-TIME historical repair: link/create Airtable Members for paying Stripe customers.
 *
 * The Stripe webhook NEVER creates members. Use this CLI only for backfill.
 * Ongoing registration: Memberstack → Make → Airtable (upsert by Memberstack ID / email).
 *
 *   npm run airtable:historical-stripe-repair -- --dry-run
 *   npm run airtable:historical-stripe-repair -- --apply-links
 *   npm run airtable:historical-stripe-repair -- --apply --create-missing
 *   npm run airtable:historical-stripe-repair -- --dry-run --stripe-customer-id=cus_xxx
 *   npm run airtable:historical-stripe-repair -- --dry-run --limit=20
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
  listStripeCustomersForRepair,
  parseHistoricalRepairArgs,
  repairPayingStripeCustomer,
  rowsToCsv,
  type HistoricalRepairRow,
} from "../src/lib/billing/historical-stripe-member-repair";

dotenv.config();

export { parseHistoricalRepairArgs };

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

async function main() {
  let args: ReturnType<typeof parseHistoricalRepairArgs>;
  try {
    args = parseHistoricalRepairArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  const modeParts: string[] = [];
  if (args.dryRun) modeParts.push("DRY-RUN (no writes)");
  if (args.applyLinks && !args.apply) modeParts.push("APPLY-LINKS (link + access only)");
  if (args.apply) modeParts.push("APPLY");
  if (args.canCreate) modeParts.push("CREATE-MISSING enabled");
  console.log(`Mode: ${modeParts.join(" · ")}\n`);
  console.log(
    "Note: Webhook never creates Members. This script is historical repair only.\n"
  );

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

  console.log("Listing Stripe customers...");
  const customers = await listStripeCustomersForRepair(stripe, {
    stripeCustomerId: args.stripeCustomerId,
    limit: args.limit,
  });
  console.log(`Customers to inspect: ${customers.length}\n`);

  const CONCURRENCY = 3;
  let done = 0;
  const rows = await mapPool(customers, CONCURRENCY, async (customer) => {
    try {
      const row = await repairPayingStripeCustomer({
        airtable,
        stripe,
        customer,
        membershipPriceIds,
        canLink: args.canLink,
        canCreate: args.canCreate,
        dryRun: args.dryRun,
      });
      done++;
      if (done % 10 === 0 || done === customers.length) {
        console.log(`  progress ${done}/${customers.length}`);
      }
      return row;
    } catch (e) {
      done++;
      const msg = e instanceof Error ? e.message : String(e);
      const row: HistoricalRepairRow = {
        stripeCustomerId: customer.id,
        emailMasked: "",
        airtableRecordId: "",
        action: "error",
        paidThrough: "",
        reason: msg.slice(0, 200),
        updated: false,
        created: false,
        linked: false,
      };
      return row;
    }
  });

  const counts = new Map<string, number>();
  for (const r of rows) {
    counts.set(r.action, (counts.get(r.action) || 0) + 1);
  }

  console.log("\n=== Summary ===");
  for (const [action, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${action}: ${n}`);
  }
  console.log(`  total: ${rows.length}`);
  console.log(
    `  written: linked=${rows.filter((r) => r.linked).length} created=${rows.filter((r) => r.created).length} updated=${rows.filter((r) => r.updated).length}`
  );

  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, rowsToCsv(rows), "utf8");
  console.log(`\nCSV: ${args.output}`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("sync-paying-stripe-members-to-airtable.ts") ||
    process.argv[1].includes("sync-paying-stripe-members-to-airtable"));

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
