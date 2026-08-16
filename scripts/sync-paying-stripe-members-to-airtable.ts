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
 *
 * Active-subscription mode (--subscriptions): reconciles every active+trialing
 * Stripe subscription whose items contain a configured membership price_ id to
 * Airtable. Access date = subscription current_period_end (NOT paid invoices).
 * Links blank Stripe Customer IDs via unique primary email and creates missing
 * Members with --apply --create-missing. Monotonic — never shortens access.
 *
 *   npm run airtable:historical-stripe-repair -- --subscriptions --dry-run
 *   npm run airtable:historical-stripe-repair -- --subscriptions --apply --create-missing
 *   npm run airtable:historical-stripe-repair -- --subscriptions --dry-run --stripe-customer-id=cus_xxx
 *   npm run airtable:historical-stripe-repair -- --subscriptions --dry-run --limit=20
 */
import * as dotenv from "dotenv";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import {
  getConfiguredMembershipPriceIds,
  getStripeClient,
  getStripeNativeMembershipPriceIds,
} from "../src/lib/integrations/stripe";
import {
  MEMBERS_TABLE,
  SERVICE_ACCESS_FIELD,
  resolveNativeMembershipAllowlist,
} from "../src/lib/billing/service-access-sync";
import {
  listActiveMembershipSubscriptions,
  listStripeCustomersForRepair,
  parseHistoricalRepairArgs,
  repairActiveSubscription,
  repairPayingStripeCustomer,
  rowsToCsv,
  type ActiveMembershipSubscription,
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

async function countAirtableFutureAccess(
  airtable: ReturnType<typeof createAirtableClient>
): Promise<number> {
  const date = new Date().toISOString().slice(0, 10);
  const records = await airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `IS_AFTER({${SERVICE_ACCESS_FIELD}}, "${date}")`,
  });
  return records.length;
}

async function runActiveSubscriptionSync(
  stripe: ReturnType<typeof getStripeClient>,
  airtable: ReturnType<typeof createAirtableClient>,
  args: ReturnType<typeof parseHistoricalRepairArgs>
): Promise<void> {
  let allow: Set<string>;
  try {
    allow = resolveNativeMembershipAllowlist(
      getStripeNativeMembershipPriceIds({
        requireConfigured: true,
        failClosedInProduction: false,
      })
    );
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
  console.log(`Membership price_ allowlist (${allow.size}): ${[...allow].join(", ")}\n`);

  console.log("Listing active+trialing Stripe subscriptions...");
  const memberships = await listActiveMembershipSubscriptions(stripe, allow, {
    limit: args.stripeCustomerId ? undefined : args.limit,
  });

  let scoped = args.stripeCustomerId
    ? memberships.filter((m) => m.stripeCustomerId === args.stripeCustomerId)
    : memberships;
  if (args.limit && args.limit > 0) {
    scoped = scoped.slice(0, args.limit);
  }

  console.log(
    `Stripe active+trialing qualifying memberships: ${memberships.length} (unique customers)`
  );
  console.log(`To process: ${scoped.length}\n`);

  const CONCURRENCY = 3;
  let done = 0;
  const rows = await mapPool(scoped, CONCURRENCY, async (membership) => {
    try {
      let customer = membership.customer;
      if (!customer || typeof customer.email !== "string" || !customer.email.trim()) {
        try {
          const fetched = await stripe.customers.retrieve(membership.stripeCustomerId);
          const isDeleted =
            typeof fetched === "object" &&
            fetched !== null &&
            "deleted" in fetched &&
            Boolean((fetched as { deleted?: boolean }).deleted);
          if (!isDeleted) {
            customer = fetched as ActiveMembershipSubscription["customer"];
          }
        } catch {
          /* keep expanded customer (may lack email → skipped_no_email) */
        }
      }
      const row = await repairActiveSubscription({
        airtable,
        customer,
        membership,
        canLink: args.canLink,
        canCreate: args.canCreate,
        dryRun: args.dryRun,
      });
      done++;
      if (done % 25 === 0 || done === scoped.length) {
        console.log(`  progress ${done}/${scoped.length}`);
      }
      return row;
    } catch (e) {
      done++;
      const msg = e instanceof Error ? e.message : String(e);
      const row: HistoricalRepairRow = {
        stripeCustomerId: membership.stripeCustomerId,
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

  console.log("\n=== Parity report ===");
  console.log(`Stripe active+trialing qualifying memberships: ${memberships.length}`);
  let airtableFutureAccess = -1;
  try {
    airtableFutureAccess = await countAirtableFutureAccess(airtable);
  } catch (e) {
    console.warn(`Airtable future-access count failed: ${e instanceof Error ? e.message : e}`);
  }
  if (airtableFutureAccess >= 0) {
    console.log(`Airtable members with future Service access until: ${airtableFutureAccess}`);
    console.log(`Delta (Airtable - Stripe): ${airtableFutureAccess - memberships.length}`);
  }
  console.log(
    "(monotonic mode — access is never shortened; a negative delta closes as members are added/fixed)"
  );

  mkdirSync(dirname(args.output), { recursive: true });
  writeFileSync(args.output, rowsToCsv(rows), "utf8");
  console.log(`\nCSV: ${args.output}`);
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
  if (args.subscriptions) modeParts.push("ACTIVE-SUBSCRIPTIONS");
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

  const stripe = getStripeClient();
  const airtable = createAirtableClient({ apiKey: token, baseId });

  if (args.subscriptions) {
    await runActiveSubscriptionSync(stripe, airtable, args);
    return;
  }

  let membershipPriceIds: Set<string>;
  try {
    membershipPriceIds = getConfiguredMembershipPriceIds({ requireConfigured: true });
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

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
