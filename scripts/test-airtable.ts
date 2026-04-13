/**
 * Quick script to test Airtable connection.
 * Usage: npx tsx scripts/test-airtable.ts [table-name]
 */
import { createAirtableClient } from "../src/lib/integrations/airtable";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!token || !baseId) {
    console.error("Missing AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID in .env");
    process.exit(1);
  }

  const client = createAirtableClient({ apiKey: token, baseId });
  const table = process.argv[2];

  if (!table) {
    console.log("Usage: npx tsx scripts/test-airtable.ts <table-name>");
    console.log("Example: npx tsx scripts/test-airtable.ts Members");
    console.log("\nConnection config:");
    console.log(`  Base ID: ${baseId}`);
    console.log(`  Token:   ${token.slice(0, 8)}...${token.slice(-4)}`);
    console.log("\nTrying to list tables via Airtable metadata API...");

    try {
      const res = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        console.error(`\nMetadata API error: ${res.status} ${res.statusText}`);
        if (res.status === 401) console.error("Check your token — it may be invalid or missing scopes.");
        if (res.status === 403) console.error("Token needs 'schema.bases:read' scope to list tables.");
        process.exit(1);
      }
      const data = await res.json();
      console.log(`\nFound ${data.tables.length} table(s):`);
      for (const t of data.tables) {
        console.log(`  - ${t.name} (${t.id})`);
      }
      console.log(`\nRun again with a table name: npx tsx scripts/test-airtable.ts "${data.tables[0]?.name}"`);
    } catch (err) {
      console.error("Failed to reach Airtable API:", err);
    }
  } else {
    console.log(`Fetching records from "${table}"...`);
    try {
      const records = await client.listRecords(table, { maxRecords: 5 });
      console.log(`\nGot ${records.length} record(s):\n`);
      for (const r of records) {
        console.log(`  [${r.id}]`, JSON.stringify(r.fields, null, 2));
      }
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
    }
  }
}

main();
