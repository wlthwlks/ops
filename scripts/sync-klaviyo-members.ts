/**
 * CLI for the Klaviyo membership-list sync (same pipeline as the daily
 * future-access-parity cron, but runnable on demand).
 *
 *   npm run klaviyo:sync-members                       # dry-run preview (no Klaviyo writes)
 *   npm run klaviyo:sync-members -- --apply            # full sync (imports + list reconcile)
 *   npm run klaviyo:sync-members -- --apply --limit=50 # small sanity run
 *
 * Reads the same env vars as the cron:
 *   KLAVIYO_PRIVATE_API_KEY / KLAVIYO_ACTIVE_LIST_ID / KLAVIYO_CHURNED_LIST_ID
 *   AIRTABLE_GET_DATA_TOKEN / AIRTABLE_BASE_ID
 *   Optional: KLAVIYO_API_REVISION
 */
import * as dotenv from "dotenv";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { createKlaviyoClient } from "../src/lib/integrations/klaviyo";
import {
  getStripeClient,
  getStripeNativeMembershipPriceIds,
} from "../src/lib/integrations/stripe";
import { resolveNativeMembershipAllowlist } from "../src/lib/billing/service-access-sync";
import {
  buildKlaviyoProfiles,
  computeKlaviyoCensus,
  fetchCityCountries,
  fetchMemberEnrichment,
  syncKlaviyoMembershipLists,
} from "../src/lib/billing/klaviyo-membership-sync";
import { extractStripeCustomerEmail } from "../src/lib/billing/webhook-invoice-sync";

dotenv.config();

export function parseKlaviyoSyncArgs(argv: string[]): {
  apply: boolean;
  limit?: number;
} {
  const apply = argv.includes("--apply");
  let limit: number | undefined;

  for (const arg of argv) {
    if (arg === "--apply") continue;
    if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.slice("--limit=".length), 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`Invalid --limit value: ${arg}`);
      }
      limit = n;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: npm run klaviyo:sync-members -- [--apply] [--limit=N]",
          "",
          "  --apply      perform the Klaviyo writes (default is dry-run preview)",
          "  --limit=N    cap each Stripe census listing at N customers (sanity runs)",
        ].join("\n")
      );
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return { apply, limit };
}

function requireEnv(name: string): string {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

async function main() {
  let args: ReturnType<typeof parseKlaviyoSyncArgs>;
  try {
    args = parseKlaviyoSyncArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  console.log(`Mode: ${args.apply ? "APPLY (writes to Klaviyo)" : "DRY-RUN (no Klaviyo writes)"}`);
  if (args.limit) console.log(`Census limit per Stripe listing: ${args.limit}`);
  console.log("");

  let klaviyoApiKey: string;
  let activeListId: string;
  let churnedListId: string;
  let airtableToken: string;
  let airtableBaseId: string;
  try {
    klaviyoApiKey = requireEnv("KLAVIYO_PRIVATE_API_KEY");
    activeListId = requireEnv("KLAVIYO_ACTIVE_LIST_ID");
    churnedListId = requireEnv("KLAVIYO_CHURNED_LIST_ID");
    airtableToken = requireEnv("AIRTABLE_GET_DATA_TOKEN");
    airtableBaseId = requireEnv("AIRTABLE_BASE_ID");
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

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

  const stripe = getStripeClient();
  const airtable = createAirtableClient({
    apiKey: airtableToken,
    baseId: airtableBaseId,
  });
  const klaviyo = createKlaviyoClient({
    apiKey: klaviyoApiKey,
    revision: (process.env.KLAVIYO_API_REVISION || "").trim() || undefined,
  });

  console.log("Computing Stripe census (active+trialing / canceled)...");
  const census = await computeKlaviyoCensus({
    stripe,
    membershipPriceIds: allow,
    limit: args.limit,
  });
  console.log(`  active:   ${census.active.length}`);
  console.log(`  churned:  ${census.churned.length}\n`);

  const emails = [
    ...census.active.map((m) =>
      (extractStripeCustomerEmail(m.customer) ?? "").trim().toLowerCase()
    ),
    ...census.churned.map((m) =>
      (extractStripeCustomerEmail(m.customer) ?? "").trim().toLowerCase()
    ),
  ];

  console.log("Fetching Airtable enrichment...");
  const enrichmentByEmail = await fetchMemberEnrichment(airtable, emails);
  console.log(`  enriched rows: ${enrichmentByEmail.size}\n`);

  const citiesById = await fetchCityCountries(airtable);
  console.log(`  city records: ${citiesById.size}\n`);

  const built = buildKlaviyoProfiles({
    active: census.active,
    churned: census.churned,
    enrichmentByEmail,
    citiesById,
  });

  console.log("=== Preview ===");
  console.log(`  profiles to upsert:  ${built.profiles.length}`);
  console.log(`  subscribe → active list:   ${built.activeEmails.length}`);
  console.log(`  unsubscribe → active list: ${built.churnedEmails.length}`);
  console.log(`  subscribe → churned list:  ${built.churnedEmails.length}`);
  console.log(`  unsubscribe → churned list: ${built.activeEmails.length}`);
  console.log(`  skipped (no/invalid email): ${built.skippedNoEmail}`);
  console.log(
    `  lists: active=${activeListId} churned=${churnedListId} revision=${(process.env.KLAVIYO_API_REVISION || "").trim() || "2026-07-15"}`
  );

  if (!args.apply) {
    console.log(
      "\nDRY-RUN complete — no Klaviyo writes made. Pass --apply to run the real sync."
    );
    return;
  }

  console.log("\nSyncing Klaviyo lists...");
  const result = await syncKlaviyoMembershipLists({
    klaviyo,
    activeListId,
    churnedListId,
    profiles: built.profiles,
    activeEmails: built.activeEmails,
    churnedEmails: built.churnedEmails,
    skippedNoEmail: built.skippedNoEmail,
  });

  console.log("\n=== Klaviyo sync result ===");
  console.log(JSON.stringify(result, null, 2));
  console.log(
    "\nProfile import job completed; list membership changes are applied by Klaviyo promptly."
  );
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("sync-klaviyo-members.ts") ||
    process.argv[1].includes("sync-klaviyo-members"));

if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e : e);
    process.exit(1);
  });
}
