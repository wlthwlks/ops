import { NextResponse } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { CITIES } from "@/lib/constants";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError } from "@/lib/ops/api-response";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { hasServiceAccess } from "@/lib/introduction/service-access";

interface GrowingCity {
  city: string;
  count: number;
}

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return v == null ? "" : String(v);
}

export async function GET() {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!token || !baseId) {
    return NextResponse.json(
      { success: false, error: "Missing Airtable credentials" },
      { status: 500 }
    );
  }

  const client = createAirtableClient({ apiKey: token, baseId });

  const records = await client.listRecords("MEMBERS", {
    fields: [
      MEMBER_FIELDS.city,
      MEMBER_FIELDS.membership,
      MEMBER_FIELDS.payment,
      MEMBER_FIELDS.serviceAccessUntil,
    ],
  });

  const referenceDate = new Date();
  const cityMap = new Map<string, number>();
  const listedCityMap = new Map<string, number>();

  for (const r of records) {
    const membership = fieldStr(r.fields, MEMBER_FIELDS.membership);
    const payment = fieldStr(r.fields, MEMBER_FIELDS.payment);
    const until = fieldStr(r.fields, MEMBER_FIELDS.serviceAccessUntil) || null;
    if (!hasServiceAccess(membership, payment, until, referenceDate)) continue;

    const rawCity = fieldStr(r.fields, MEMBER_FIELDS.city).trim();

    let label = "";
    for (const group of CITIES) {
      for (const alt of [group.label, ...group.alternatives]) {
        if (rawCity.toLowerCase().includes(alt.toLowerCase())) {
          label = group.label;
          break;
        }
      }
      if (label) break;
    }

    if (label) {
      listedCityMap.set(label, (listedCityMap.get(label) ?? 0) + 1);
    } else {
      const city = rawCity || "Unknown";
      cityMap.set(city, (cityMap.get(city) ?? 0) + 1);
    }
  }

  const data: GrowingCity[] = Array.from(cityMap.entries())
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count);

  const listedCities: GrowingCity[] = Array.from(listedCityMap.entries())
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count);

  const totalUnlistedMembers = data.reduce((sum, c) => sum + c.count, 0);
  const totalListedMembers = listedCities.reduce((sum, c) => sum + c.count, 0);

  return NextResponse.json({
    success: true,
    totalUnlistedMembers,
    totalListedMembers,
    data,
    listedCities,
  });
}
