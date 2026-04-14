import { NextRequest, NextResponse } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { CITIES, CityGroup } from "@/lib/constants";

interface SublocationBreakdown {
  sublocation: string;
  emails: string[];
}

interface CityExport {
  city: string;
  filename: string;
  emails: string[];
  csv: string;
  breakdown: SublocationBreakdown[];
}

function buildCityFilter(cityGroup: CityGroup): string {
  const allNames = [cityGroup.label, ...cityGroup.alternatives];
  const conditions = allNames.map(
    (name) => `FIND(LOWER("${name}"), LOWER({City}))`
  );
  return `OR(${conditions.join(", ")})`;
}

function matchSublocation(city: string, cityGroup: CityGroup): string {
  const cityLower = (city || "").toLowerCase();
  const allNames = [cityGroup.label, ...cityGroup.alternatives];
  for (const name of allNames) {
    if (cityLower.includes(name.toLowerCase())) {
      return name;
    }
  }
  return city || "Other";
}

export async function GET(request: NextRequest) {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!token || !baseId) {
    return NextResponse.json(
      { success: false, error: "Missing Airtable credentials" },
      { status: 500 }
    );
  }

  const cityParam = request.nextUrl.searchParams.get("city");
  const format = request.nextUrl.searchParams.get("format");
  const startDate = request.nextUrl.searchParams.get("startDate");
  const endDate = request.nextUrl.searchParams.get("endDate");
  const client = createAirtableClient({ apiKey: token, baseId });

  const today = new Date().toISOString().slice(0, 10);
  const effectiveStart = startDate || today;
  const effectiveEnd = endDate || today;

  const dateLabel =
    effectiveStart === effectiveEnd
      ? effectiveStart.replace(/-/g, "")
      : `${effectiveStart.replace(/-/g, "")}-${effectiveEnd.replace(/-/g, "")}`;

  const dateFilter =
    effectiveStart === effectiveEnd
      ? `IS_SAME(CREATED_TIME(), "${effectiveStart}", "day")`
      : `AND(IS_AFTER(CREATED_TIME(), DATEADD("${effectiveStart}", -1, "days")), IS_BEFORE(CREATED_TIME(), DATEADD("${effectiveEnd}", 1, "days")))`;

  const citiesToFetch = cityParam
    ? CITIES.filter((c) => c.label.toLowerCase() === cityParam.toLowerCase())
    : [...CITIES];

  const results: CityExport[] = [];

  for (const cityGroup of citiesToFetch) {
    const cityFilter = buildCityFilter(cityGroup);

    const records = await client.listRecords("Members", {
      filterByFormula: `AND({Membership} = "Active", {Payment} = "Paid", ${cityFilter}, ${dateFilter})`,
      sort: [{ field: "Date added", direction: "desc" }],
      fields: ["Name", "email", "City"],
    });

    // Build sublocation breakdown
    const sublocationMap = new Map<string, string[]>();
    const allEmails: string[] = [];

    for (const r of records) {
      const email = r.fields["email"] as string;
      if (!email) continue;

      allEmails.push(email);
      const recordCity = r.fields["City"] as string;
      const sublocation = matchSublocation(recordCity, cityGroup);

      const existing = sublocationMap.get(sublocation) ?? [];
      sublocationMap.set(sublocation, [...existing, email]);
    }

    const breakdown: SublocationBreakdown[] = Array.from(sublocationMap.entries())
      .map(([sublocation, emails]) => ({ sublocation, emails }))
      .sort((a, b) => b.emails.length - a.emails.length);

    const slug = cityGroup.label.toLowerCase().replace(/\s+/g, "-");
    const filename = `${dateLabel}-${slug}-new-customers.csv`;
    const csv = allEmails.join(",");

    results.push({ city: cityGroup.label, filename, emails: allEmails, csv, breakdown });
  }

  if (cityParam && format === "csv" && results.length === 1) {
    const { filename, csv } = results[0];
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  return NextResponse.json({
    success: true,
    startDate: effectiveStart,
    endDate: effectiveEnd,
    data: results.map(({ city, filename, emails, csv, breakdown }) => ({
      city,
      filename,
      count: emails.length,
      emails,
      csv,
      breakdown,
    })),
  });
}
