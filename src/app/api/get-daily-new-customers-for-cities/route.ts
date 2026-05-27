import { NextRequest, NextResponse } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { CITIES, CityGroup } from "@/lib/constants";

interface SublocationBreakdown {
  sublocation: string;
  emails: string[];
}

interface CustomerRecord {
  name: string;
  surname: string;
  email: string;
  city: string;
  phone: string;
}

interface CityExport {
  city: string;
  filename: string;
  emails: string[];
  csv: string;
  customers: CustomerRecord[];
  breakdown: SublocationBreakdown[];
}

function buildCityFilter(cityGroup: CityGroup): string {
  const allNames = [cityGroup.label, ...cityGroup.alternatives];
  const conditions = allNames.map(
    (name) => `FIND(LOWER("${name}"), LOWER({City}))`
  );
  return `OR(${conditions.join(", ")})`;
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
  try {
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
      sort: [{ field: "Date joined", direction: "desc" }],
    });

    // Build sublocation breakdown
    const sublocationMap = new Map<string, string[]>();
    const allEmails: string[] = [];
    const allCustomers: CustomerRecord[] = [];

    for (const r of records) {
      const email = r.fields["email"] as string;
      if (!email) continue;

      allEmails.push(email);
      const recordCity = r.fields["City"] as string;
      const sublocation = matchSublocation(recordCity, cityGroup);

      allCustomers.push({
        name: (r.fields["First Name"] as string) || "",
        surname: (r.fields["Last Name"] as string) || "",
        email,
        city: recordCity || "",
        phone: (r.fields["phone number"] as string) || "",
      });

      const existing = sublocationMap.get(sublocation) ?? [];
      sublocationMap.set(sublocation, [...existing, email]);
    }

    const breakdown: SublocationBreakdown[] = Array.from(sublocationMap.entries())
      .map(([sublocation, emails]) => ({ sublocation, emails }))
      .sort((a, b) => b.emails.length - a.emails.length);

    const slug = cityGroup.label.toLowerCase().replace(/\s+/g, "-");
    const filename = `${dateLabel}-${slug}-new-customers.csv`;
    const csv = allEmails.join(",");

    results.push({ city: cityGroup.label, filename, emails: allEmails, csv, customers: allCustomers, breakdown });
  }

  // Fetch "Other" members: get ALL active+paid for the date range, then exclude already-matched emails
  if (!cityParam) {
    const allRecords = await client.listRecords("Members", {
      filterByFormula: `AND({Membership} = "Active", {Payment} = "Paid", ${dateFilter})`,
      sort: [{ field: "Date joined", direction: "desc" }],
    });

    const matchedEmails = new Set(results.flatMap((r) => r.emails));

    const otherEmails: string[] = [];
    const otherCustomers: CustomerRecord[] = [];
    const otherSublocationMap = new Map<string, string[]>();

    for (const r of allRecords) {
      const email = r.fields["email"] as string;
      if (!email || matchedEmails.has(email)) continue;

      const recordCity = (r.fields["City"] as string) || "Unknown";
      otherEmails.push(email);
      otherCustomers.push({
        name: (r.fields["First Name"] as string) || "",
        surname: (r.fields["Last Name"] as string) || "",
        email,
        city: recordCity,
        phone: (r.fields["phone number"] as string) || "",
      });

      const existing = otherSublocationMap.get(recordCity) ?? [];
      otherSublocationMap.set(recordCity, [...existing, email]);
    }

    const breakdown: SublocationBreakdown[] = Array.from(otherSublocationMap.entries())
      .map(([sublocation, emails]) => ({ sublocation, emails }))
      .sort((a, b) => b.emails.length - a.emails.length);

    const filename = `${dateLabel}-other-new-customers.csv`;
    const csv = otherEmails.join(",");
    results.push({ city: "Other", filename, emails: otherEmails, csv, customers: otherCustomers, breakdown });
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

  console.log("[API] cities returned:", results.map(r => `${r.city}(${r.emails.length})`).join(", "));

  return NextResponse.json({
    success: true,
    startDate: effectiveStart,
    endDate: effectiveEnd,
    data: results.map(({ city, filename, emails, csv, customers, breakdown }) => ({
      city,
      filename,
      count: emails.length,
      emails,
      csv,
      customers,
      breakdown,
    })),
  });
  } catch (err) {
    console.error("[API] get-daily-new-customers-for-cities error:", err);
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}
