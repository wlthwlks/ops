import { NextRequest, NextResponse } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";

interface CancelledMember {
  id: string;
  name: string;
  surname: string;
  email: string;
  city: string;
  phone: string;
  membershipStatus: string;
}

function isCancelled(membershipValue: unknown): boolean {
  if (!membershipValue) return false;
  return String(membershipValue).toLowerCase().includes("cancel");
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

  const startDate = request.nextUrl.searchParams.get("startDate");
  const endDate = request.nextUrl.searchParams.get("endDate");
  const client = createAirtableClient({ apiKey: token, baseId });

  const today = new Date().toISOString().slice(0, 10);
  const effectiveStart = startDate || today;
  const effectiveEnd = endDate || today;

  const dateFilter =
    effectiveStart === effectiveEnd
      ? `IS_SAME(CREATED_TIME(), "${effectiveStart}", "day")`
      : `AND(IS_AFTER(CREATED_TIME(), DATEADD("${effectiveStart}", -1, "days")), IS_BEFORE(CREATED_TIME(), DATEADD("${effectiveEnd}", 1, "days")))`;

  // Fetch ALL members in date range, filter cancelled in code
  const allRecords = await client.listRecords("Members", {
    filterByFormula: dateFilter,
    sort: [{ field: "Date added", direction: "desc" }],
  });

  // Debug: show distribution of membership values
  const membershipCounts = allRecords.reduce<Record<string, number>>((acc, r) => {
    const val = String(r.fields["Membership"] ?? "(empty)");
    acc[val] = (acc[val] ?? 0) + 1;
    return acc;
  }, {});

  console.log("[remove-members] membership distribution:", JSON.stringify(membershipCounts));

  const members: CancelledMember[] = allRecords
    .filter((r) => isCancelled(r.fields["Membership"]))
    .map((r) => ({
      id: r.id,
      name: (r.fields["First Name"] as string) || "",
      surname: (r.fields["Last Name"] as string) || "",
      email: (r.fields["email"] as string) || "",
      city: (r.fields["City"] as string) || "",
      phone: (r.fields["phone number"] as string) || "",
      membershipStatus: String(r.fields["Membership"] ?? ""),
    }))
    .filter((m) => m.email);

  return NextResponse.json({
    success: true,
    startDate: effectiveStart,
    endDate: effectiveEnd,
    total: members.length,
    debug_membershipDistribution: membershipCounts,
    data: members,
  });
}
