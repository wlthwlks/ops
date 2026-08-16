/**
 * Read-only parity audit: Airtable members with future "Service access until"
 * that do NOT correspond to a qualifying active/trialing Stripe subscription.
 *
 * Explains the positive delta reported by
 * `npm run airtable:historical-stripe-repair -- --subscriptions --dry-run`
 * (Airtable future-access count minus Stripe qualifying memberships).
 *
 * Never writes. Outputs:
 *   - console summary grouped by reason
 *   - CSV at tmp/future-access-parity-audit.csv
 *
 *   npm run airtable:audit-future-access-parity
 *
 * Shares its computation with the daily cron route
 * (/api/cron/future-access-parity) via computeFutureAccessParity.
 */
import * as dotenv from "dotenv";
import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import {
  getStripeClient,
  getStripeNativeMembershipPriceIds,
} from "../src/lib/integrations/stripe";
import {
  MEMBERS_TABLE,
  SERVICE_ACCESS_FIELD,
  STRIPE_CUSTOMER_ID_FIELD,
  STRIPE_SUBSCRIPTION_ID_FIELD,
  STRIPE_SUBSCRIPTION_STATUS_FIELD,
  CANCEL_AT_PERIOD_END_FIELD,
  CANCELLATION_EFFECTIVE_AT_FIELD,
  resolveNativeMembershipAllowlist,
} from "../src/lib/billing/service-access-sync";
import { subscriptionItemPriceIds } from "../src/lib/billing/historical-stripe-member-repair";
import {
  computeFutureAccessParity,
  fieldStr,
  type ParityExtraRow,
} from "../src/lib/billing/future-access-parity";

dotenv.config();

type AuditRow = ParityExtraRow & {
  memberstackPlanId: string;
  memberstackId: string;
  stripeSubscriptionId: string;
  stripeSubscriptionStatus: string;
  cancelAtPeriodEnd: string;
  cancellationEffectiveAt: string;
  stripeCustomerExists: string;
  stripeSubStatuses: string;
  stripeSubPriceIds: string;
  stripeHasQualifyingPrice: string;
};

const MEMBERSTACK_PLAN_ID_FIELD = "Memberstack Plan ID";
const MEMBERSTACK_ID_FIELD = "Memberstack ID";

function csvEscape(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

async function main() {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    console.error("Missing AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID");
    process.exit(1);
  }

  const stripe = getStripeClient();
  const airtable = createAirtableClient({ apiKey: token, baseId });

  const allow = resolveNativeMembershipAllowlist(
    getStripeNativeMembershipPriceIds({
      requireConfigured: true,
      failClosedInProduction: false,
    })
  );
  console.log(`Membership price_ allowlist (${allow.size}): ${[...allow].join(", ")}\n`);

  console.log("Listing Stripe active+trialing qualifying memberships...");
  const parity = await computeFutureAccessParity({
    stripe,
    airtable,
    membershipPriceIds: allow,
  });
  console.log(`Stripe qualifying memberships: ${parity.stripeQualifying}\n`);

  const date = new Date().toISOString().slice(0, 10);
  console.log(`Airtable members with Service access until after ${date}: ${parity.airtableFutureAccess}\n`);

  if (parity.duplicates.length > 0) {
    console.log(`Duplicate Stripe Customer IDs across future-access records:`);
    for (const d of parity.duplicates) console.log(`  ${d.stripeCustomerId}: ${d.count} records`);
    console.log("");
  }

  // Enrich extras with Stripe customer/subscription detail (CLI report only).
  const enrichedFields = await airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `IS_AFTER({${SERVICE_ACCESS_FIELD}}, "${date}")`,
    fields: [
      MEMBERSTACK_PLAN_ID_FIELD,
      MEMBERSTACK_ID_FIELD,
      STRIPE_SUBSCRIPTION_ID_FIELD,
      STRIPE_SUBSCRIPTION_STATUS_FIELD,
      CANCEL_AT_PERIOD_END_FIELD,
      CANCELLATION_EFFECTIVE_AT_FIELD,
    ],
  });
  const extraDetailById = new Map(
    enrichedFields.map((r) => [r.id, r.fields] as const)
  );

  const rows: AuditRow[] = [];
  for (const extra of parity.extras) {
    const detail = extraDetailById.get(extra.airtableRecordId) ?? {};
    let stripeCustomerExists = "";
    let stripeSubStatuses = "";
    let stripeSubPriceIds = "";
    let stripeHasQualifyingPrice = "";
    if (extra.reason === "cus_id_not_in_qualifying_set") {
      try {
        const customer = await stripe.customers.retrieve(extra.stripeCustomerId);
        const deleted =
          typeof customer === "object" &&
          customer !== null &&
          "deleted" in customer &&
          Boolean((customer as { deleted?: boolean }).deleted);
        stripeCustomerExists = deleted ? "deleted" : "exists";
        if (!deleted) {
          const subs = await stripe.subscriptions.list({
            customer: extra.stripeCustomerId,
            limit: 100,
            expand: ["data.items.data.price"],
          });
          const statuses = [...new Set(subs.data.map((s: { status: string }) => s.status))];
          stripeSubStatuses = statuses.join("|") || "none";
          const priceIds = [
            ...new Set(
              subs.data.flatMap((s: { items?: { data?: unknown[] } }) =>
                subscriptionItemPriceIds(s as never)
              )
            ),
          ];
          stripeSubPriceIds = priceIds.join("|") || "none";
          const anyQualifying = subs.data.some((s: { items?: { data?: unknown[] } }) =>
            subscriptionItemPriceIds(s as never).some((id) => allow.has(id))
          );
          stripeHasQualifyingPrice = anyQualifying ? "yes" : "no";
        }
      } catch (e) {
        stripeCustomerExists = `error: ${e instanceof Error ? e.message.slice(0, 80) : e}`;
      }
    }
    rows.push({
      ...extra,
      memberstackPlanId: fieldStr(detail, MEMBERSTACK_PLAN_ID_FIELD),
      memberstackId: fieldStr(detail, MEMBERSTACK_ID_FIELD),
      stripeSubscriptionId: fieldStr(detail, STRIPE_SUBSCRIPTION_ID_FIELD),
      stripeSubscriptionStatus: fieldStr(detail, STRIPE_SUBSCRIPTION_STATUS_FIELD),
      cancelAtPeriodEnd: fieldStr(detail, CANCEL_AT_PERIOD_END_FIELD),
      cancellationEffectiveAt: fieldStr(detail, CANCELLATION_EFFECTIVE_AT_FIELD),
      stripeCustomerExists,
      stripeSubStatuses,
      stripeSubPriceIds,
      stripeHasQualifyingPrice,
    });
  }

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.reason, (counts.get(row.reason) || 0) + 1);
  console.log("=== Extra future-access records (not matched to qualifying Stripe membership) ===");
  for (const [reason, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${n}`);
  }
  console.log(`  total extra: ${rows.length}`);
  console.log("");

  console.log("=== Qualifying Stripe memberships with NO future-access Airtable record ===");
  console.log(`  total holes: ${parity.holes.length}`);
  for (const h of parity.holes) {
    const email = h.email;
    const end = h.currentPeriodEndIso;
    console.log(
      `  ${h.membership.stripeCustomerId}  ${email}  sub=${h.membership.subscriptionId} status=${h.membership.subscriptionStatus} period_end=${end}`
    );
    if (email) {
      try {
        const byEmail = await airtable.listRecords(MEMBERS_TABLE, {
          filterByFormula: `LOWER({email}) = "${email.toLowerCase()}"`,
          fields: [STRIPE_CUSTOMER_ID_FIELD, SERVICE_ACCESS_FIELD, "Name"],
        });
        for (const r of byEmail) {
          console.log(
            `    → airtable rec ${r.id}  name=${fieldStr(r.fields, "Name")}  cus=${fieldStr(
              r.fields,
              STRIPE_CUSTOMER_ID_FIELD
            )}  access=${fieldStr(r.fields, SERVICE_ACCESS_FIELD)}`
          );
        }
        if (byEmail.length === 0) console.log(`    → no Airtable member by email`);
      } catch (e) {
        console.log(`    → email lookup failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  console.log("");

  const headers: (keyof AuditRow)[] = [
    "airtableRecordId",
    "email",
    "name",
    "stripeCustomerId",
    "accessUntil",
    "payment",
    "membership",
    "memberstackPlanId",
    "memberstackId",
    "stripeSubscriptionId",
    "stripeSubscriptionStatus",
    "cancelAtPeriodEnd",
    "cancellationEffectiveAt",
    "reason",
    "stripeCustomerExists",
    "stripeSubStatuses",
    "stripeSubPriceIds",
    "stripeHasQualifyingPrice",
  ];
  const csv =
    headers.join(",") +
    "\n" +
    rows
      .map((row) => headers.map((h) => csvEscape(row[h])).join(","))
      .join("\n") +
    "\n";

  const output = "tmp/future-access-parity-audit.csv";
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, csv, "utf8");
  console.log(`CSV: ${output}`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("audit-future-access-parity.ts") ||
    process.argv[1].includes("audit-future-access-parity"));

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
