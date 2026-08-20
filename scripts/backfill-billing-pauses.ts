/**
 * Backfill Stripe pause-collection state into Airtable.
 *
 * Two modes:
 *
 * 1) Pause backfill (default)
 *    Lists every Stripe subscription with pause_collection set (status stays
 *    "active" for pause collection) or status "paused" and applies the same
 *    Airtable sync as the always-on webhook: Stripe subscription status =
 *    "paused", Billing pause until = resume date (blank = indefinite),
 *    Service access until = now, Membership = "Paused".
 *
 * 2) Resume reconciliation (--reconcile-resumes)
 *    Lists Airtable members flagged as paused (status "paused" or a non-empty
 *    "Billing pause until") and checks live Stripe: any member whose
 *    subscription is no longer paused gets the resume sync (restores
 *    Membership=Active and access). Catches missed "resumed" webhooks.
 *
 * Usage:
 *   npm run billing:backfill-pauses                    (dry-run, mode 1, .env)
 *   npm run billing:backfill-pauses -- --apply         (apply, mode 1, .env)
 *   npm run billing:backfill-pauses:local -- --apply   (apply, mode 1, .env.local)
 *   npm run billing:backfill-pauses -- --reconcile-resumes
 *   npm run billing:backfill-pauses -- --reconcile-resumes --apply
 *   npm run billing:backfill-pauses -- --env-file=.env.local --apply
 */
import * as dotenv from "dotenv";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { getStripeClient } from "../src/lib/integrations/stripe";
import {
  MEMBERS_TABLE,
  SERVICE_ACCESS_FIELD,
  STRIPE_CUSTOMER_ID_FIELD,
  STRIPE_SUBSCRIPTION_STATUS_FIELD,
} from "../src/lib/billing/service-access-sync";
import {
  pauseResumeDateFromSubscription,
  syncSubscriptionPausedToAirtable,
  syncSubscriptionResumedToAirtable,
} from "../src/lib/billing/pause-sync";

const BILLING_PAUSE_UNTIL_FIELD = "Billing pause until";

const args = process.argv.slice(2);

// Env file selection: --env-file=<path> (default ".env"; use ".env.local"
// via the billing:backfill-pauses:local npm script or --env-file=.env.local).
const envFileArg = args.find((a) => a.startsWith("--env-file="));
const envFilePath = envFileArg ? envFileArg.split("=")[1] : ".env";
const runArgs = args.filter((a) => a !== envFileArg);

dotenv.config({ path: envFilePath, override: false });
console.log(`Env file: ${envFilePath}`);

const apply = runArgs.includes("--apply");
const reconcileResumes = runArgs.includes("--reconcile-resumes");

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

async function main() {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) throw new Error("AIRTABLE_GET_DATA_TOKEN / AIRTABLE_BASE_ID missing");

  const airtable = createAirtableClient({ apiKey: token, baseId });
  const stripe = getStripeClient();

  if (!reconcileResumes) {
    // ── Mode 1: Stripe → Airtable pause backfill ──
    // Pause collection does NOT change subscription status (it stays
    // "active") — list active/paused subs and filter on pause_collection.
    const subs = [];
    for (const status of ["active", "paused"] as const) {
      for await (const sub of stripe.subscriptions.list({
        status,
        limit: 100,
      })) {
        if (sub.pause_collection != null || sub.status === "paused") {
          subs.push(sub);
        }
      }
    }
    console.log(
      `Found ${subs.length} paused Stripe subscription(s) (mode: ${apply ? "apply" : "dry-run"})`
    );
    for (const sub of subs) {
      const resumesAt = pauseResumeDateFromSubscription(sub);
      console.log(
        `- ${sub.id} customer=${sub.customer} ${resumesAt ? `resumes ${resumesAt}` : "indefinite"}`
      );
      const result = await syncSubscriptionPausedToAirtable({
        airtable,
        sub,
        dryRun: !apply,
      });
      console.log(`  → ${result.status}: ${result.reason}`);
    }
    return;
  }

  // ── Mode 2: Airtable → Stripe resume reconciliation ──
  const records = await airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `OR({${STRIPE_SUBSCRIPTION_STATUS_FIELD}} = "paused", {${BILLING_PAUSE_UNTIL_FIELD}} != "")`,
    fields: [
      "Name",
      "email",
      STRIPE_CUSTOMER_ID_FIELD,
      SERVICE_ACCESS_FIELD,
      STRIPE_SUBSCRIPTION_STATUS_FIELD,
      BILLING_PAUSE_UNTIL_FIELD,
    ],
  });
  console.log(
    `Found ${records.length} Airtable member(s) flagged as paused (mode: ${apply ? "apply" : "dry-run"})`
  );

  let restored = 0;
  for (const record of records) {
    const cus = fieldStr(record.fields, STRIPE_CUSTOMER_ID_FIELD);
    if (!cus.startsWith("cus_")) {
      console.log(`- SKIP ${record.id} (${fieldStr(record.fields, "email")}) — no Stripe Customer ID`);
      continue;
    }
    let stillPaused = false;
    try {
      const subs = await stripe.subscriptions.list({ customer: cus, status: "all", limit: 10 });
      for (const sub of subs.data) {
        if (sub.status === "paused" || sub.pause_collection != null) {
          stillPaused = true;
          break;
        }
        if (sub.status === "active" || sub.status === "trialing") {
          const result = await syncSubscriptionResumedToAirtable({
            airtable,
            sub,
            dryRun: !apply,
          });
          console.log(
            `- RESUME ${record.id} (${fieldStr(record.fields, "email")}) sub=${sub.id} → ${result.status}`
          );
          if (result.status === "updated") restored++;
        }
      }
    } catch (err) {
      console.log(
        `- ERROR ${record.id}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    if (stillPaused) {
      console.log(
        `- STILL PAUSED ${record.id} (${fieldStr(record.fields, "email")}) — leaving as-is`
      );
    }
  }
  console.log(`Restored ${restored} member(s).`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
