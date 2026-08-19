/**
 * One-off cleanup: clear the placeholder business description that the
 * update-details refresh flow used to pre-fill for members with a blank
 * description ("I'm refreshing my WLTH WLKS profile so introductions stay
 * aligned with where my business is today.").
 *
 * Usage:
 *   npx tsx scripts/clear-fake-business-description.ts            # dry run
 *   npx tsx scripts/clear-fake-business-description.ts --apply    # clear fields
 */
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { MEMBERS_TABLE, MEMBER_FIELDS } from "../src/lib/ops/airtable-fields";

const FAKE_TEXT =
  "I'm refreshing my WLTH WLKS profile so introductions stay aligned with where my business is today.";

function normalize(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const FAKE_NORMALIZED = normalize(FAKE_TEXT);

async function main() {
  const apply = process.argv.includes("--apply");
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    console.error("AIRTABLE_GET_DATA_TOKEN / AIRTABLE_BASE_ID not set");
    process.exit(1);
  }

  const airtable = createAirtableClient({ apiKey: token, baseId });

  const records = await airtable.listRecords(MEMBERS_TABLE, {
    fields: [MEMBER_FIELDS.email, MEMBER_FIELDS.businessDescription],
  });

  const matches = records.filter((r) => {
    const raw = r.fields[MEMBER_FIELDS.businessDescription];
    if (raw == null) return false;
    return normalize(String(raw)) === FAKE_NORMALIZED;
  });

  console.log(`Scanned ${records.length} members; found ${matches.length} with the placeholder description.`);

  if (matches.length > 0) {
    console.log("Samples:");
    for (const m of matches.slice(0, 20)) {
      console.log(
        `  ${m.id} | ${String(m.fields[MEMBER_FIELDS.email] ?? "")}`
      );
    }
  }

  if (!apply) {
    console.log("Dry run — pass --apply to clear the field on these records.");
    return;
  }
  if (matches.length === 0) {
    console.log("Nothing to apply.");
    return;
  }

  const updates = matches.map((m) => ({
    id: m.id,
    fields: { [MEMBER_FIELDS.businessDescription]: "" },
  }));
  await airtable.updateRecordsBatched(MEMBERS_TABLE, updates);
  console.log(`Cleared Business description on ${updates.length} records.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
