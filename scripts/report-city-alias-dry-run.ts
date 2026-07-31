/**
 * Dry-run report: compare MEMBERS.City text / City relation against live ALL CITIES catalogue.
 * Does NOT write or migrate anything.
 *
 *   npx tsx scripts/report-city-alias-dry-run.ts
 */
import "dotenv/config";
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { MEMBER_FIELDS, MEMBERS_TABLE } from "../src/lib/ops/airtable-fields";
import { loadLocationCatalog } from "../src/lib/forms/reference-data";

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

async function main() {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    console.error("AIRTABLE_GET_DATA_TOKEN and AIRTABLE_BASE_ID required");
    process.exit(1);
  }

  const airtable = createAirtableClient({ apiKey: token, baseId });
  const catalog = await loadLocationCatalog(airtable, { force: true });

  const byLegacy = new Map<string, string>();
  for (const c of catalog.cities) {
    byLegacy.set(normalizeCityLabel(c.legacyCityLabel), c.code);
  }

  const members = await airtable.listRecords(MEMBERS_TABLE, {
    fields: [MEMBER_FIELDS.city, MEMBER_FIELDS.cityRelation, MEMBER_FIELDS.email],
  });

  const counts = new Map<string, number>();
  let blank = 0;
  let matchedByRelation = 0;
  let matchedByName = 0;
  let unmatched = 0;
  const unmatchedSamples: string[] = [];

  for (const m of members) {
    const rel = m.fields[MEMBER_FIELDS.cityRelation];
    const relId =
      Array.isArray(rel) && typeof rel[0] === "string" ? (rel[0] as string) : "";
    if (relId && catalog.cities.some((c) => c.code === relId)) {
      matchedByRelation++;
      continue;
    }

    const city = fieldStr(m.fields, MEMBER_FIELDS.city);
    if (!city) {
      blank++;
      continue;
    }
    counts.set(city, (counts.get(city) || 0) + 1);
    const mapped = byLegacy.get(normalizeCityLabel(city));
    if (mapped) matchedByName++;
    else {
      unmatched++;
      if (unmatchedSamples.length < 30) unmatchedSamples.push(city);
    }
  }

  console.log(
    JSON.stringify(
      {
        dryRun: true,
        catalogCountries: catalog.countries.length,
        catalogCities: catalog.cities.length,
        totalMembers: members.length,
        matchedByCityRelation: matchedByRelation,
        matchedByCityName: matchedByName,
        blankCity: blank,
        unmatchedCityText: unmatched,
        topLegacyCities: [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 40)
          .map(([city, count]) => ({ city, count })),
        unmatchedSamples: [...new Set(unmatchedSamples)],
        note: "No writes performed. Forms now write City + City relation from live ALL CITIES ids.",
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
