/**
 * List cities with their active-member counts, sorted biggest to smallest,
 * using the same active-member logic as introductions
 * (countActiveMembersByCity: hasServiceAccess + City relation link).
 *
 * Usage: npx tsx scripts/cities-by-active-members.ts
 */
import * as dotenv from "dotenv";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { CITIES_TABLE } from "@/lib/ops/airtable-fields";
import {
  countActiveMembersByCity,
  cityNameFromRecord,
} from "@/lib/introduction/city-sync";

dotenv.config();

async function main() {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!token || !baseId) {
    console.error("Missing AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID in .env");
    process.exit(1);
  }

  const airtable = createAirtableClient({ apiKey: token, baseId });

  const cityRecords = await airtable.listRecords(CITIES_TABLE, {
    fields: ["City"],
  });

  const memberRecords = await airtable.listRecords("Members", {
    fields: [
      "Membership",
      "Payment",
      "Service access until",
      "City relation",
    ],
  });

  const counts = countActiveMembersByCity(cityRecords, memberRecords);

  const cities = cityRecords
    .map((r) => ({
      name: cityNameFromRecord(r.fields) ?? r.id,
      count: counts.get(r.id) ?? 0,
    }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  console.log("\n=== Cities by active members ===\n");
  for (const city of cities) {
    console.log(`${String(city.count).padStart(4)}  ${city.name}`);
  }

  const total = cities.reduce((sum, c) => sum + c.count, 0);
  console.log(`\nTotal: ${cities.length} cities, ${total} active members`);
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
