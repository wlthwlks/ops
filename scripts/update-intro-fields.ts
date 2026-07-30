/**
 * Updates Members table with First introduction status and Recurring eligible from.
 *
 * Usage:
 *   npx tsx scripts/update-intro-fields.ts          (live run)
 *   npx tsx scripts/update-intro-fields.ts --dry-run  (preview only)
 *
 * Logic:
 *   - Members with "Date joined" on or before 7/23/2026:
 *       First introduction status = "Grandfathered"
 *       Recurring eligible from = "2026-07-24"
 *   - All other members:
 *       First introduction status = "Pending"
 *       First introduction sent at = null (blank)
 *       Recurring eligible from = null (blank)
 */
import { createAirtableClient } from "../src/lib/integrations/airtable";
import * as dotenv from "dotenv";

dotenv.config();

const CUTOFF_DATE = new Date("2026-07-23T23:59:59Z");
const GRANDFATHERED_DATE = "2026-07-24";
const BATCH_SIZE = 10;

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) console.log("🔍 DRY RUN — no writes will be performed\n");

  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!token || !baseId) {
    console.error("Missing AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID in .env");
    process.exit(1);
  }

  const client = createAirtableClient({ apiKey: token, baseId });

  console.log("Fetching all Members...");
  const allRecords = await client.listRecords("Members", {
    fields: ["Name", "Date joined"],
  });
  console.log(`Fetched ${allRecords.length} member(s)\n`);

  const grandfathered: typeof allRecords = [];
  const pending: typeof allRecords = [];

  for (const rec of allRecords) {
    const dateJoinedRaw = rec.fields["Date joined"];
    const dateJoined = dateJoinedRaw ? new Date(String(dateJoinedRaw)) : null;
    const name = String(rec.fields["Name"] || "(no name)");

    if (dateJoined && dateJoined <= CUTOFF_DATE) {
      grandfathered.push(rec);
      console.log(`  Grandfathered: ${name} (joined ${dateJoined.toISOString().slice(0, 10)})`);
    } else {
      pending.push(rec);
      console.log(`  Pending:       ${name} (joined ${dateJoined ? dateJoined.toISOString().slice(0, 10) : "N/A"})`);
    }
  }

  console.log(`\nSummary: ${grandfathered.length} grandfathered, ${pending.length} pending`);

  if (dryRun) {
    console.log("\nDry run complete — no changes applied.");
    return;
  }

  // ── Update grandfathered members in batches ──
  if (grandfathered.length > 0) {
    console.log(`\nWriting ${grandfathered.length} grandfathered updates...`);
    for (let i = 0; i < grandfathered.length; i += BATCH_SIZE) {
      const batch = grandfathered.slice(i, i + BATCH_SIZE);
      const records = batch.map((r) => ({
        id: r.id,
        fields: {
          "First introduction status": "Grandfathered",
          "Recurring eligible from": GRANDFATHERED_DATE,
        },
      }));
      await client.updateRecords("Members", records);
      console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: updated ${records.length} record(s)`);
    }
  }

  // ── Update pending members in batches ──
  if (pending.length > 0) {
    console.log(`\nWriting ${pending.length} pending updates...`);
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      const records = batch.map((r) => ({
        id: r.id,
        fields: {
          "First introduction status": "Pending",
          "First introduction sent at": null,
          "Recurring eligible from": null,
        },
      }));
      await client.updateRecords("Members", records);
      console.log(`  Batch ${Math.floor(i / BATCH_SIZE) + 1}: updated ${records.length} record(s)`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
