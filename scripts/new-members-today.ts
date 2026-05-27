/**
 * Fetch all active paid members who signed up today.
 * Usage: npx tsx scripts/new-members-today.ts
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

  const today = new Date().toISOString().slice(0, 10);

  const records = await client.listRecords("Members", {
    filterByFormula: `AND({Membership} = "Active", {Payment} = "Paid", IS_SAME(CREATED_TIME(), "${today}", "day"))`,
    sort: [{ field: "Date joined", direction: "desc" }],
    fields: [
      "Name",
      "email",
      "City",
      "Country",
      "Industry",
      "Traction",
      "Date joined",
    ],
  });

  console.log(`\n=== New Active Paid Members — ${today} ===\n`);

  if (records.length === 0) {
    console.log("No new active paid members signed up today.");
    return;
  }

  console.log(
    `${"#".padEnd(3)} ${"Name".padEnd(25)} ${"Email".padEnd(35)} ${"City".padEnd(15)} ${"Country".padEnd(15)} ${"Industry".padEnd(15)} ${"Traction"}`
  );
  console.log("-".repeat(120));

  for (const [i, r] of records.entries()) {
    const f = r.fields;
    console.log(
      `${String(i + 1).padEnd(3)} ${String(f["Name"] || "").padEnd(25)} ${String(f["email"] || "").padEnd(35)} ${String(f["City"] || "").padEnd(15)} ${String(f["Country"] || "").padEnd(15)} ${String(f["Industry"] || "").padEnd(15)} ${String(f["Traction"] || "")}`
    );
  }

  console.log(`\nTotal: ${records.length} new member(s) today`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
