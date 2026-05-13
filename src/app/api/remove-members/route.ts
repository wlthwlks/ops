import { NextRequest, NextResponse } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";

interface CancelledMember {
  id: string;
  name: string;
  surname: string;
  email: string;
  city: string;
  phone: string;
  cancelledDate: string;
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

  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");

  if (!startDate || !endDate) {
    return NextResponse.json(
      { success: false, error: "startDate and endDate query params are required (YYYY-MM-DD)" },
      { status: 400 }
    );
  }

  const client = createAirtableClient({ apiKey: token, baseId });

  // Use Airtable formula to filter:
  // - Cancellation date is not blank (member is cancelled)
  // - Cancellation date falls within the selected range (inclusive)
  const formula = `AND({Cancellation date} != '', IS_AFTER({Cancellation date}, DATEADD('${startDate}', -1, 'days')), IS_BEFORE({Cancellation date}, DATEADD('${endDate}', 1, 'days')))`;

  const records = await client.listRecords("Members", {
    filterByFormula: formula,
    sort: [{ field: "Cancellation date", direction: "desc" }],
  });

  const members: CancelledMember[] = records
    .map((r) => ({
      id: r.id,
      name: (r.fields["First Name"] as string) || "",
      surname: (r.fields["Last Name"] as string) || "",
      email: (r.fields["email"] as string) || "",
      city: (r.fields["City"] as string) || "",
      phone: (r.fields["phone number"] as string) || "",
      cancelledDate: (r.fields["Cancellation date"] as string) || "",
    }))
    .filter((m) => m.email);

  return NextResponse.json({
    success: true,
    total: members.length,
    startDate,
    endDate,
    data: members,
  });
}
