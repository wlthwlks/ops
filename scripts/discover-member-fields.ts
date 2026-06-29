/**
 * READ-ONLY: discover the Members table columns so we can find the
 * "time availability" field name. Tries the Airtable metadata API first
 * (exact schema), then falls back to sampling records.
 *
 * Usage: npx tsx scripts/discover-member-fields.ts
 */
import { createAirtableClient } from "../src/lib/integrations/airtable";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.development.local" });

const AVAIL_HINTS = [
  "avail",
  "time",
  "schedule",
  "day",
  "meet",
  "slot",
  "when",
  "free",
];

function looksLikeAvailability(name: string): boolean {
  const lower = name.toLowerCase();
  return AVAIL_HINTS.some((h) => lower.includes(h));
}

async function main() {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    console.error("Missing AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID");
    process.exit(1);
  }

  // ── 1. Try metadata API for the exact schema ──
  console.log("=== Trying Airtable metadata API (exact schema) ===");
  try {
    const res = await fetch(
      `https://api.airtable.com/v0/meta/bases/${baseId}/tables`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (res.ok) {
      const data = await res.json();
      const members = data.tables.find(
        (t: { name: string }) => t.name.toLowerCase() === "members"
      );
      if (members) {
        console.log(`\nMembers table — ${members.fields.length} fields:`);
        for (const f of members.fields) {
          const flag = looksLikeAvailability(f.name) ? "  <-- AVAILABILITY?" : "";
          console.log(`  - "${f.name}" (${f.type})${flag}`);
        }
      } else {
        console.log("No 'Members' table found in metadata.");
      }
    } else {
      console.log(`Metadata API ${res.status} ${res.statusText} (likely missing schema.bases:read scope). Falling back to sampling.`);
    }
  } catch (err) {
    console.log("Metadata API failed, falling back to sampling:", err instanceof Error ? err.message : err);
  }

  // ── 2. Fallback / corroboration: sample records, collect field keys ──
  console.log("\n=== Sampling records (field keys present on data) ===");
  const client = createAirtableClient({ apiKey: token, baseId });
  const records = await client.listRecords("Members", { maxRecords: 25 });
  const keys = new Set<string>();
  for (const r of records) Object.keys(r.fields).forEach((k) => keys.add(k));

  const sorted = Array.from(keys).sort();
  console.log(`\n${sorted.length} distinct field key(s) across ${records.length} sampled record(s):`);
  for (const k of sorted) {
    console.log(`  - "${k}"${looksLikeAvailability(k) ? "  <-- AVAILABILITY?" : ""}`);
  }

  // Show sample values for any availability-like fields.
  const availKeys = sorted.filter(looksLikeAvailability);
  if (availKeys.length > 0) {
    console.log("\n=== Sample values for availability-like fields ===");
    for (const key of availKeys) {
      const samples = records
        .map((r) => r.fields[key])
        .filter((v) => v !== undefined && v !== null && String(v).trim() !== "")
        .slice(0, 5);
      console.log(`  "${key}": ${JSON.stringify(samples)}`);
    }
  } else {
    console.log("\nNo availability-like field keys found in sampled records.");
  }
}

main();
