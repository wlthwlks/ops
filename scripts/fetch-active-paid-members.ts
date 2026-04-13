/**
 * Fetch latest 10 active + paid members from Airtable.
 * Usage: npx tsx scripts/fetch-active-paid-members.ts
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

  const records = await client.listRecords("Members", {
    filterByFormula: 'AND({Membership} = "Active", {Payment} = "Paid")',
    sort: [{ field: "Date added", direction: "desc" }],
    maxRecords: 10,
    fields: [
      "Name",
      "email",
      "City",
      "Country",
      "Industry",
      "Traction",
      "Membership",
      "Payment",
      "Date added",
      "Days Active",
    ],
  });

  console.log(`\n=== Latest 10 Active & Paid Members ===\n`);
  console.log(
    `${"#".padEnd(3)} ${"Name".padEnd(25)} ${"Email".padEnd(35)} ${"City".padEnd(15)} ${"Industry".padEnd(15)} ${"Traction".padEnd(15)} ${"Date Added".padEnd(12)} ${"Days"}`
  );
  console.log("-".repeat(130));

  for (const [i, r] of records.entries()) {
    const f = r.fields;
    const dateAdded = f["Date added"]
      ? new Date(f["Date added"] as string).toISOString().slice(0, 10)
      : "N/A";

    console.log(
      `${String(i + 1).padEnd(3)} ${String(f["Name"] || "").padEnd(25)} ${String(f["email"] || "").padEnd(35)} ${String(f["City"] || "").padEnd(15)} ${String(f["Industry"] || "").padEnd(15)} ${String(f["Traction"] || "").padEnd(15)} ${dateAdded.padEnd(12)} ${String(f["Days Active"] || "")}`
    );
  }

  console.log(`\nTotal: ${records.length} records`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
