/**
 * Delete the fake directory members created by seed-directory-members.ts.
 *
 * SAFETY: only runs against the preview base with SEED_DIRECTORY=yes.
 *
 * Run: SEED_DIRECTORY=yes npx tsx scripts/cleanup-directory-members.ts --env-file=.env.local
 */
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { MEMBERS_TABLE, MEMBER_FIELDS } from "../src/lib/ops/airtable-fields";

const PREVIEW_BASE_ID = "applsfPMbycl6VM1p";

async function main() {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  if (baseId !== PREVIEW_BASE_ID) {
    console.error(
      `Refusing to clean: AIRTABLE_BASE_ID=${baseId ?? "(unset)"} is not the preview base (${PREVIEW_BASE_ID}).`
    );
    process.exit(1);
  }
  if (process.env.SEED_DIRECTORY !== "yes") {
    console.error("Refusing to clean: set SEED_DIRECTORY=yes to confirm.");
    process.exit(1);
  }
  if (!token) {
    console.error("AIRTABLE_GET_DATA_TOKEN is not set.");
    process.exit(1);
  }

  const airtable = createAirtableClient({ apiKey: token, baseId });
  const records = await airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `LEFT({${MEMBER_FIELDS.memberstackId}}, 5) = 'seed-'`,
    fields: [MEMBER_FIELDS.memberstackId],
  });

  console.log(`Found ${records.length} seed members. Deleting…`);

  let deleted = 0;
  for (const r of records) {
    const res = await fetch(
      `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(MEMBERS_TABLE)}/${r.id}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.ok) deleted++;
    else console.error(`Failed to delete ${r.id}: ${res.status}`);
  }

  console.log(`Deleted ${deleted} seed members.`);
}

main().catch((err) => {
  console.error("Cleanup failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
