import { NextRequest, NextResponse } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { CITIES } from "@/lib/constants";

interface CityExport {
  city: string;
  filename: string;
  emails: string[];
  csv: string;
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

  // Build date filter: for single day use IS_SAME, for range use IS_AFTER/IS_BEFORE
  const dateFilter =
    effectiveStart === effectiveEnd
      ? `IS_SAME(CREATED_TIME(), "${effectiveStart}", "day")`
      : `AND(IS_AFTER(CREATED_TIME(), DATEADD("${effectiveStart}", -1, "days")), IS_BEFORE(CREATED_TIME(), DATEADD("${effectiveEnd}", 1, "days")))`;

  const citiesToFetch = cityParam
    ? CITIES.filter((c) => c.toLowerCase() === cityParam.toLowerCase())
    : [...CITIES];

  const results: CityExport[] = [];

  for (const city of citiesToFetch) {
    const records = await client.listRecords("Members", {
      filterByFormula: `AND({Membership} = "Active", {Payment} = "Paid", {City} = "${city}", ${dateFilter})`,
      sort: [{ field: "Date added", direction: "desc" }],
      fields: ["Name", "email", "City"],
    });

    const emails = records
      .map((r) => r.fields["email"] as string)
      .filter(Boolean);

    const slug = city.toLowerCase().replace(/\s+/g, "-");
    const filename = `${dateLabel}-${slug}-new-customers.csv`;
    const csv = emails.join(",");

    results.push({ city, filename, emails, csv });
  }

  // If single city + format=csv, return as downloadable CSV file
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
    data: results.map(({ city, filename, emails, csv }) => ({
      city,
      filename,
      count: emails.length,
      emails,
      csv,
    })),
  });
}
