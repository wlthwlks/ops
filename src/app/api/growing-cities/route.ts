import { NextResponse } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { CITIES } from "@/lib/constants";

interface GrowingCity {
  city: string;
  count: number;
}

function buildExcludeAllCitiesFilter(): string {
  const conditions = CITIES.flatMap((group) => {
    const allNames = [group.label, ...group.alternatives];
    return allNames.map(
      (name) => `FIND(LOWER("${name}"), LOWER({City}))`
    );
  });
  return `AND(NOT(OR(${conditions.join(", ")})))`;
}

export async function GET() {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!token || !baseId) {
    return NextResponse.json(
      { success: false, error: "Missing Airtable credentials" },
      { status: 500 }
    );
  }

  const client = createAirtableClient({ apiKey: token, baseId });
  const excludeFilter = buildExcludeAllCitiesFilter();

  const [unlistedRecords, listedRecords] = await Promise.all([
    client.listRecords("Members", {
      filterByFormula: `AND({Membership} = "Active", {Payment} = "Paid", ${excludeFilter})`,
      sort: [{ field: "Date joined", direction: "desc" }],
    }),
    client.listRecords("Members", {
      filterByFormula: `AND({Membership} = "Active", {Payment} = "Paid", NOT(${excludeFilter}))`,
    }),
  ]);

  const cityMap = new Map<string, number>();

  for (const r of unlistedRecords) {
    const city = ((r.fields["City"] as string) || "Unknown").trim();
    cityMap.set(city, (cityMap.get(city) ?? 0) + 1);
  }

  const data: GrowingCity[] = Array.from(cityMap.entries())
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count);

  // Build per-city counts for listed (tracked) cities
  const listedCityMap = new Map<string, number>();
  for (const r of listedRecords) {
    const rawCity = ((r.fields["City"] as string) || "").trim().toLowerCase();
    // Resolve to the canonical city label
    let label = "Other";
    for (const group of CITIES) {
      for (const alt of [group.label, ...group.alternatives]) {
        if (rawCity.includes(alt.toLowerCase())) {
          label = group.label;
          break;
        }
      }
      if (label !== "Other") break;
    }
    if (label !== "Other") {
      listedCityMap.set(label, (listedCityMap.get(label) ?? 0) + 1);
    }
  }

  const listedCities: GrowingCity[] = Array.from(listedCityMap.entries())
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count);

  return NextResponse.json({
    success: true,
    totalUnlistedMembers: unlistedRecords.length,
    totalListedMembers: listedRecords.length,
    data,
    listedCities,
  });
}
