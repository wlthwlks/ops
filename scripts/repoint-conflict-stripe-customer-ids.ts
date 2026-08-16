/**
 * Repoint Airtable members whose "Stripe Customer ID" points at an outdated
 * Stripe customer to their current qualifying customer id.
 *
 * Background: `airtable:historical-stripe-repair -- --subscriptions` skips
 * members whose record holds a DIFFERENT customer id than the one holding
 * the active qualifying subscription (skipped_customer_id_conflict). Run the
 * read-only audit first:
 *
 *   npm run airtable:audit-future-access-parity
 *
 * This script fixes exactly the pairs listed in REPOINTS below. For each
 * pair it VERIFIES the Airtable record still holds `oldCustomerId` and the
 * primary email matches before writing — mismatches are skipped and printed.
 *
 *   npm run airtable:repoint-conflict-customer-ids                (dry-run)
 *   npm run airtable:repoint-conflict-customer-ids -- --apply
 *
 * After applying, re-run:
 *   npm run airtable:historical-stripe-repair -- --subscriptions --apply
 * to reconcile access/billing fields for the repointed records.
 */
import * as dotenv from "dotenv";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import {
  MEMBERS_TABLE,
  STRIPE_CUSTOMER_ID_FIELD,
} from "../src/lib/billing/service-access-sync";

dotenv.config();

type Repoint = {
  airtableRecordId: string;
  email: string;
  oldCustomerId: string;
  newCustomerId: string;
  note: string;
};

/**
 * Edit this list. Only pairs you are confident about should remain when
 * running with --apply. Each entry must match the audit output exactly.
 */
const REPOINTS: Repoint[] = [
  {
    airtableRecordId: "recztBZaGyTc4idmv",
    email: "hi@joycesavage.com",
    oldCustomerId: "cus_UcaCVkm6Lexp5s",
    newCustomerId: "cus_UdKqghNwTdM2Fl",
    note: "stale link, access blank — urgent",
  },
  {
    airtableRecordId: "recUpiQoBAlAcoaX6",
    email: "kristen@deardesign.com.au",
    oldCustomerId: "cus_UVCbYntGb7kGHF",
    newCustomerId: "cus_SCOXMtTqWusY0k",
    note: "stale link, access blank — urgent",
  },
  // The 7 below still have an ACTIVE subscription on the old customer with a
  // NON-allowlisted price. Check the old subscription in the Stripe dashboard
  // before uncommenting (see README / audit CSV for price ids).
  // {
  //   airtableRecordId: "recZjNdxd3UctfBzK",
  //   email: "julia@wellnessfromwithinnp.com",
  //   oldCustomerId: "cus_V36iMaxyEBCBTT",
  //   newCustomerId: "cus_UpEWS373RcmgaJ",
  //   note: "old cus active on price_1SCM7yBwwz36JKiynI3Fm6Qr",
  // },
  // {
  //   airtableRecordId: "recZiyW1ttkecKmza",
  //   email: "alex@intuitivefinance.com.au",
  //   oldCustomerId: "cus_TrpJtudElpLhtz",
  //   newCustomerId: "cus_TlOcLRg2Ujt7Rk",
  //   note: "old cus active on non-allowlisted price",
  // },
  // {
  //   airtableRecordId: "recq9ZI8XH6ITaskA",
  //   email: "londa@manifestedadventures.com",
  //   oldCustomerId: "cus_TmlVPBA2vUo2ef",
  //   newCustomerId: "cus_Tjtw3CLIuk0AJE",
  //   note: "old cus active on price_1SCMATBwwz36JKiyB9dyWr1V",
  // },
  // {
  //   airtableRecordId: "recyaIN43hzBA8NSh",
  //   email: "michelle@michellebarr.com",
  //   oldCustomerId: "cus_Tht4CWfmxUYr8f",
  //   newCustomerId: "cus_TNfZ5XIgtyUCDB",
  //   note: "old cus active on price_1SCMATBwwz36JKiyB9dyWr1V",
  // },
  // {
  //   airtableRecordId: "rechKJHpFkuEkj6Eo",
  //   email: "chelsie.pyland@citycave.com",
  //   oldCustomerId: "cus_U0Ir6onQ5B7Jui",
  //   newCustomerId: "cus_THEUrjrCOxbivJ",
  //   note: "old cus active on price_1Sq8KoBwwz36JKiy8d31ujkE",
  // },
  // {
  //   airtableRecordId: "recXbo0qsdjkmWHIn",
  //   email: "tesshilmo@gmail.com",
  //   oldCustomerId: "cus_TAwAlRD3bOqNtn",
  //   newCustomerId: "cus_T7zDMGKfclVN1n",
  //   note: "old cus active on price_1SCLTpBwwz36JKiyEpO7EbF4",
  // },
  // {
  //   airtableRecordId: "rec0YFtueGZKjwuEo",
  //   email: "meri@northsidefinanceco.com",
  //   oldCustomerId: "cus_SqOt9f7PdvVOxb",
  //   newCustomerId: "cus_Sh1USiFq26SprH",
  //   note: "old cus active on price_1RwH6bBwwz36JKiyk0hJt778",
  // },
];

async function main() {
  const apply = process.argv.includes("--apply");
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    console.error("Missing AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID");
    process.exit(1);
  }
  const airtable = createAirtableClient({ apiKey: token, baseId });

  console.log(`Mode: ${apply ? "APPLY" : "DRY-RUN (no writes)"}\n`);
  console.log(`Entries in REPOINTS: ${REPOINTS.length}\n`);

  let applied = 0;
  let skipped = 0;
  for (const rp of REPOINTS) {
    let record;
    try {
      record = await airtable.getRecord(MEMBERS_TABLE, rp.airtableRecordId);
    } catch (e) {
      console.error(
        `✗ ${rp.email}: getRecord failed — ${e instanceof Error ? e.message : e}`
      );
      skipped++;
      continue;
    }
    const currentCus = String(record.fields[STRIPE_CUSTOMER_ID_FIELD] ?? "").trim();
    const currentEmail = String(record.fields.email ?? "").trim().toLowerCase();
    const expectedEmail = rp.email.trim().toLowerCase();

    if (currentCus !== rp.oldCustomerId) {
      console.error(
        `✗ ${rp.email}: expected old cus ${rp.oldCustomerId} but record holds "${currentCus}" — skipped`
      );
      skipped++;
      continue;
    }
    if (currentEmail && currentEmail !== expectedEmail) {
      console.error(
        `✗ ${rp.email}: email mismatch (record has "${currentEmail}") — skipped`
      );
      skipped++;
      continue;
    }

    console.log(
      `${apply ? "✓" : "→"} ${rp.email}  rec ${rp.airtableRecordId}  ${rp.oldCustomerId} → ${rp.newCustomerId}  [${rp.note}]`
    );
    if (apply) {
      await airtable.updateRecordsBatched(MEMBERS_TABLE, [
        {
          id: rp.airtableRecordId,
          fields: { [STRIPE_CUSTOMER_ID_FIELD]: rp.newCustomerId },
        },
      ]);
    }
    applied++;
  }

  console.log(`\napplied: ${apply ? applied : `${applied} (would apply)`}  skipped: ${skipped}`);
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("repoint-conflict-stripe-customer-ids.ts") ||
    process.argv[1].includes("repoint-conflict-stripe-customer-ids"));

if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
