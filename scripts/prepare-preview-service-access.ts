/**
 * Prepare the PREVIEW base for manual-introduction testing by granting every
 * member a future "Service access until" date (and clearing any paused Stripe
 * status), so they are eligible under the V2 service-access policy.
 *
 * The directory seed members were created without "Service access until",
 * which makes them ineligible when SERVICE_ACCESS_POLICY_V2_ENABLED=true.
 *
 * SAFETY: refuses to run unless AIRTABLE_BASE_ID is the preview base and
 * PREPARE_PREVIEW=yes is set.
 *
 * Run: PREPARE_PREVIEW=yes npx tsx scripts/prepare-preview-service-access.ts --env-file=.env.local
 */
import * as dotenv from "dotenv";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { MEMBERS_TABLE, MEMBER_FIELDS } from "../src/lib/ops/airtable-fields";

const PREVIEW_BASE_ID = "applsfPMbycl6VM1p";
const FUTURE_ACCESS = "2027-06-30T00:00:00.000Z";

const args = process.argv.slice(2);
const envFileArg = args.find((a) => a.startsWith("--env-file="));
const envFilePath = envFileArg ? envFileArg.split("=")[1] : ".env.local";
dotenv.config({ path: envFilePath, override: false });

async function main() {
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (baseId !== PREVIEW_BASE_ID) {
    console.error(
      `Refusing to run: AIRTABLE_BASE_ID=${baseId ?? "(unset)"} is not the preview base (${PREVIEW_BASE_ID}).`
    );
    process.exit(1);
  }
  if (process.env.PREPARE_PREVIEW !== "yes") {
    console.error("Refusing to run: set PREPARE_PREVIEW=yes to confirm this preview-only action.");
    process.exit(1);
  }

  const airtable = createAirtableClient({
    apiKey: process.env.AIRTABLE_GET_DATA_TOKEN!,
    baseId,
  });

  const members = await airtable.listRecords(MEMBERS_TABLE, {
    fields: [
      MEMBER_FIELDS.email,
      MEMBER_FIELDS.serviceAccessUntil,
      MEMBER_FIELDS.stripeSubscriptionStatus,
    ],
  });
  console.log(`Loaded ${members.length} member(s).`);

  const now = Date.now();
  const needsFix = members.filter((m) => {
    const sa = String(m.fields[MEMBER_FIELDS.serviceAccessUntil] ?? "").trim();
    const date = sa ? Date.parse(sa) : NaN;
    const expiredOrMissing = !Number.isFinite(date) || date < now;
    const paused =
      String(m.fields[MEMBER_FIELDS.stripeSubscriptionStatus] ?? "")
        .trim()
        .toLowerCase() === "paused";
    return expiredOrMissing || paused;
  });

  console.log(`${needsFix.length} member(s) need service access.`);

  const updates = needsFix.map((m) => ({
    id: m.id,
    fields: {
      [MEMBER_FIELDS.serviceAccessUntil]: FUTURE_ACCESS,
      [MEMBER_FIELDS.stripeSubscriptionStatus]: "active",
    },
  }));

  if (updates.length > 0) {
    const updated = await airtable.updateRecordsBatched(MEMBERS_TABLE, updates, {
      typecast: true,
    });
    console.log(`Updated ${updated.length} member(s) with future service access.`);
  } else {
    console.log("Nothing to update.");
  }
}

main().catch((err) => {
  console.error("Prepare-preview failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
