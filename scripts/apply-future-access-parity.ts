/**
 * Apply the future-access parity fix decided from the read-only audit:
 *
 *   npm run airtable:audit-future-access-parity
 *
 * 1. Repoint the 9 conflict records to the MOST RECENT Stripe customer id
 *    (the one holding the active qualifying subscription) and set their
 *    "Service access until" to that subscription's current_period_end.
 *    Each repoint verifies the record still holds the expected OLD customer
 *    id and email before writing.
 *
 * 2. Clear "Service access until" on every other Airtable record with future
 *    access whose Stripe Customer ID has NO active+trialing subscription on
 *    a listed (allowlisted) price id — i.e. past_due, non-listed prices, and
 *    customers with no subscriptions. Access from a listed-price active sub
 *    is never touched.
 *
 * Dry-run by default:
 *   npm run airtable:apply-future-access-parity
 *   npm run airtable:apply-future-access-parity -- --apply
 *
 * After applying, re-run:
 *   npm run airtable:historical-stripe-repair -- --subscriptions --apply --create-missing
 * to reconcile the repointed records' billing fields, then re-audit.
 */
import * as dotenv from "dotenv";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import {
  getStripeClient,
  getStripeNativeMembershipPriceIds,
} from "../src/lib/integrations/stripe";
import {
  MEMBERS_TABLE,
  SERVICE_ACCESS_FIELD,
  STRIPE_CUSTOMER_ID_FIELD,
  resolveNativeMembershipAllowlist,
} from "../src/lib/billing/service-access-sync";
import { listActiveMembershipSubscriptions } from "../src/lib/billing/historical-stripe-member-repair";

dotenv.config();

type Repoint = {
  airtableRecordId: string;
  email: string;
  oldCustomerId: string;
  newCustomerId: string;
  accessUntilIso: string;
  note?: string;
};

/** From the audit: 9 records whose cus id differs from the qualifying one. */
const REPOINTS: Repoint[] = [
  {
    airtableRecordId: "recZjNdxd3UctfBzK",
    email: "julia@wellnessfromwithinnp.com",
    oldCustomerId: "cus_V36iMaxyEBCBTT",
    newCustomerId: "cus_UpEWS373RcmgaJ",
    accessUntilIso: "2026-10-04T20:20:48.000Z",
  },
  {
    airtableRecordId: "recztBZaGyTc4idmv",
    email: "hi@joycesavage.com",
    oldCustomerId: "cus_UcaCVkm6Lexp5s",
    newCustomerId: "cus_UdKqghNwTdM2Fl",
    accessUntilIso: "2026-09-03T02:05:52.000Z",
  },
  {
    airtableRecordId: "recZiyW1ttkecKmza",
    email: "alex@intuitivefinance.com.au",
    oldCustomerId: "cus_TlOcLRg2Ujt7Rk",
    newCustomerId: "cus_TrpJtudElpLhtz",
    accessUntilIso: "2026-10-27T06:23:42.000Z",
    note: "most recent qualifying customer; older cus_TlOcLRg2Ujt7Rk has a duplicate active sub to cancel in Stripe",
  },
  {
    airtableRecordId: "recq9ZI8XH6ITaskA",
    email: "londa@manifestedadventures.com",
    oldCustomerId: "cus_TmlVPBA2vUo2ef",
    newCustomerId: "cus_Tjtw3CLIuk0AJE",
    accessUntilIso: "2026-10-06T02:37:13.000Z",
  },
  {
    airtableRecordId: "recyaIN43hzBA8NSh",
    email: "michelle@michellebarr.com",
    oldCustomerId: "cus_Tht4CWfmxUYr8f",
    newCustomerId: "cus_TNfZ5XIgtyUCDB",
    accessUntilIso: "2026-11-07T18:21:20.000Z",
  },
  {
    airtableRecordId: "rechKJHpFkuEkj6Eo",
    email: "chelsie.pyland@citycave.com",
    oldCustomerId: "cus_U0Ir6onQ5B7Jui",
    newCustomerId: "cus_THEUrjrCOxbivJ",
    accessUntilIso: "2026-10-21T13:55:13.000Z",
  },
  {
    airtableRecordId: "recXbo0qsdjkmWHIn",
    email: "tesshilmo@gmail.com",
    oldCustomerId: "cus_TAwAlRD3bOqNtn",
    newCustomerId: "cus_T7zDMGKfclVN1n",
    accessUntilIso: "2026-09-26T21:32:20.000Z",
  },
  {
    airtableRecordId: "rec0YFtueGZKjwuEo",
    email: "meri@northsidefinanceco.com",
    oldCustomerId: "cus_SqOt9f7PdvVOxb",
    newCustomerId: "cus_Sh1USiFq26SprH",
    accessUntilIso: "2026-10-16T22:05:40.000Z",
  },
  {
    airtableRecordId: "recUpiQoBAlAcoaX6",
    email: "kristen@deardesign.com.au",
    oldCustomerId: "cus_UVCbYntGb7kGHF",
    newCustomerId: "cus_SCOXMtTqWusY0k",
    accessUntilIso: "2026-10-26T03:49:50.000Z",
  },
];

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return v == null ? "" : String(v).trim();
}

async function main() {
  const apply = process.argv.includes("--apply");
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    console.error("Missing AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID");
    process.exit(1);
  }
  const stripe = getStripeClient();
  const airtable = createAirtableClient({ apiKey: token, baseId });

  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN (no writes)"}\n`);

  const allow = resolveNativeMembershipAllowlist(
    getStripeNativeMembershipPriceIds({
      requireConfigured: true,
      failClosedInProduction: false,
    })
  );
  console.log(`Membership price_ allowlist (${allow.size}): ${[...allow].join(", ")}\n`);

  console.log("Listing Stripe active+trialing qualifying memberships...");
  const memberships = await listActiveMembershipSubscriptions(stripe, allow);
  const qualifyingCusIds = new Set(memberships.map((m) => m.stripeCustomerId));
  console.log(`Stripe qualifying memberships: ${memberships.length}\n`);

  // ---- 1. Repoint conflict records ----
  console.log("=== Repoint conflict records (most recent cus id) ===");
  const repointIds = new Set(REPOINTS.map((r) => r.airtableRecordId));
  let repointOk = 0;
  for (const rp of REPOINTS) {
    const record = await airtable.getRecord(MEMBERS_TABLE, rp.airtableRecordId);
    const currentCus = fieldStr(record.fields, STRIPE_CUSTOMER_ID_FIELD);
    const currentEmail = fieldStr(record.fields, "email").toLowerCase();
    const expectedEmail = rp.email.toLowerCase();

    if (currentCus !== rp.oldCustomerId) {
      console.error(
        `✗ ${rp.email}: expected old cus ${rp.oldCustomerId} but record holds "${currentCus}" — skipped`
      );
      continue;
    }
    if (currentEmail && currentEmail !== expectedEmail) {
      console.error(
        `✗ ${rp.email}: email mismatch (record has "${currentEmail}") — skipped`
      );
      continue;
    }
    console.log(
      `${apply ? "✓" : "→"} ${rp.email}  rec ${rp.airtableRecordId}  ${rp.oldCustomerId} → ${rp.newCustomerId}  access=${rp.accessUntilIso}${rp.note ? `  [${rp.note}]` : ""}`
    );
    if (apply) {
      await airtable.updateRecordsBatched(MEMBERS_TABLE, [
        {
          id: rp.airtableRecordId,
          fields: {
            [STRIPE_CUSTOMER_ID_FIELD]: rp.newCustomerId,
            [SERVICE_ACCESS_FIELD]: rp.accessUntilIso,
          },
        },
      ]);
    }
    repointOk++;
  }
  console.log(`repointed: ${apply ? repointOk : `${repointOk} (would apply)`}\n`);

  // ---- 2. Clear future access without a listed-price active sub ----
  const date = new Date().toISOString().slice(0, 10);
  console.log(`Listing Airtable members with Service access until after ${date}...`);
  const records = await airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `IS_AFTER({${SERVICE_ACCESS_FIELD}}, "${date}")`,
    fields: [STRIPE_CUSTOMER_ID_FIELD, SERVICE_ACCESS_FIELD, "email", "Name", "Payment"],
  });

  const toClear = records.filter((r) => {
    if (repointIds.has(r.id)) return false;
    const cus = fieldStr(r.fields, STRIPE_CUSTOMER_ID_FIELD);
    return !qualifyingCusIds.has(cus);
  });

  console.log("=== Clear future access (no active sub on a listed price) ===");
  for (const r of toClear) {
    const cus = fieldStr(r.fields, STRIPE_CUSTOMER_ID_FIELD);
    const access = fieldStr(r.fields, SERVICE_ACCESS_FIELD);
    const name = fieldStr(r.fields, "Name");
    const payment = fieldStr(r.fields, "Payment");
    console.log(
      `${apply ? "✓" : "→"} rec ${r.id}  ${name || "(no name)"}  cus=${cus || "(none)"}  payment=${payment || "(blank)"}  access=${access}  → cleared`
    );
  }
  if (apply && toClear.length > 0) {
    await airtable.updateRecordsBatched(
      MEMBERS_TABLE,
      toClear.map((r) => ({
        id: r.id,
        fields: { [SERVICE_ACCESS_FIELD]: null },
      }))
    );
  }
  console.log(`cleared: ${apply ? toClear.length : `${toClear.length} (would clear)`}\n`);

  // ---- 3. Verification ----
  console.log("=== Verification ===");
  const afterRecords = await airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `IS_AFTER({${SERVICE_ACCESS_FIELD}}, "${date}")`,
    fields: [STRIPE_CUSTOMER_ID_FIELD],
  });
  const afterCusIds = new Set(
    afterRecords.map((r) => fieldStr(r.fields, STRIPE_CUSTOMER_ID_FIELD)).filter(Boolean)
  );
  const extraAfter = afterRecords.filter(
    (r) => !qualifyingCusIds.has(fieldStr(r.fields, STRIPE_CUSTOMER_ID_FIELD))
  );
  const holesAfter = memberships.filter((m) => !afterCusIds.has(m.stripeCustomerId));
  console.log(`Airtable future access: ${afterRecords.length}`);
  console.log(`Stripe qualifying: ${memberships.length}`);
  console.log(`Delta (Airtable - Stripe): ${afterRecords.length - memberships.length}`);
  console.log(`Extras remaining: ${extraAfter.length}`);
  console.log(`Holes remaining: ${holesAfter.length}`);
  for (const h of holesAfter.slice(0, 10)) {
    const email = typeof h.customer?.email === "string" ? h.customer.email : "";
    console.log(`  hole: ${h.stripeCustomerId} ${email}`);
  }
  for (const r of extraAfter.slice(0, 10)) {
    console.log(
      `  extra: rec ${r.id} cus=${fieldStr(r.fields, STRIPE_CUSTOMER_ID_FIELD) || "(none)"}`
    );
  }
  if (apply) {
    console.log("\nNext: npm run airtable:historical-stripe-repair -- --subscriptions --apply --create-missing");
  } else {
    console.log("\nDry-run complete. Re-run with -- --apply to write.");
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("apply-future-access-parity.ts") ||
    process.argv[1].includes("apply-future-access-parity"));

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
