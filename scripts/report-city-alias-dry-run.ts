/**
 * Dry-run report: compare legacy Airtable City values against canonical city codes.
 * Does NOT write or migrate anything.
 *
 *   npx tsx scripts/report-city-alias-dry-run.ts
 */
import "dotenv/config";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { MEMBER_FIELDS, MEMBERS_TABLE } from "../src/lib/ops/airtable-fields";
import { CITIES } from "../src/lib/forms/reference-data";

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

function normalizeCityLabel(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Built-in aliases for common historical labels → city code */
const ALIASES: Record<string, string> = {
  london: "GB-LON",
  "greater london": "GB-LON",
  manchester: "GB-MAN",
  birmingham: "GB-BIR",
  edinburgh: "GB-EDI",
  bristol: "GB-BRI",
  dublin: "IE-DUB",
  dubai: "AE-DXB",
  "new york": "US-NYC",
  nyc: "US-NYC",
  "los angeles": "US-LAX",
  la: "US-LAX",
  sydney: "AU-SYD",
  paris: "FR-PAR",
  berlin: "DE-BER",
  amsterdam: "NL-AMS",
  madrid: "ES-MAD",
  lisbon: "PT-LIS",
  lisboa: "PT-LIS",
};

async function main() {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    console.error("AIRTABLE_GET_DATA_TOKEN and AIRTABLE_BASE_ID required");
    process.exit(1);
  }

  const byLegacy = new Map<string, string>();
  for (const c of CITIES) {
    byLegacy.set(normalizeCityLabel(c.legacyCityLabel), c.code);
  }
  for (const [k, v] of Object.entries(ALIASES)) {
    byLegacy.set(k, v);
  }

  const airtable = createAirtableClient({ apiKey: token, baseId });
  const members = await airtable.listRecords(MEMBERS_TABLE, {
    fields: [MEMBER_FIELDS.city, MEMBER_FIELDS.cityCode, MEMBER_FIELDS.email],
  });

  const counts = new Map<string, number>();
  let blank = 0;
  let matched = 0;
  let unmatched = 0;
  let alreadyCoded = 0;
  const unmatchedSamples: string[] = [];

  for (const m of members) {
    const code = fieldStr(m.fields, MEMBER_FIELDS.cityCode);
    if (code) {
      alreadyCoded++;
      continue;
    }
    const city = fieldStr(m.fields, MEMBER_FIELDS.city);
    if (!city) {
      blank++;
      continue;
    }
    counts.set(city, (counts.get(city) || 0) + 1);
    const mapped = byLegacy.get(normalizeCityLabel(city));
    if (mapped) matched++;
    else {
      unmatched++;
      if (unmatchedSamples.length < 30) unmatchedSamples.push(city);
    }
  }

  console.log(
    JSON.stringify(
      {
        dryRun: true,
        totalMembers: members.length,
        alreadyHaveCityCode: alreadyCoded,
        blankCity: blank,
        legacyMatchedToCode: matched,
        legacyUnmatched: unmatched,
        topLegacyCities: [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 40)
          .map(([city, count]) => ({ city, count })),
        unmatchedSamples: [...new Set(unmatchedSamples)],
        note: "No writes performed. Historical migration remains a separate manual operation.",
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
