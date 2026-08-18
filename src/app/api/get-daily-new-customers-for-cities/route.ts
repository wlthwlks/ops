import { NextRequest, NextResponse } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError } from "@/lib/ops/api-response";
import {
  CITIES_TABLE,
  CITY_FIELDS,
  MEMBER_FIELDS,
  MEMBERS_TABLE,
  toAirtableSchemaError,
} from "@/lib/ops/airtable-fields";
import { linkedRecordIds } from "@/lib/ops/city-relation-repair";
import { normalizeCityKey } from "@/lib/ops/city-normalize";
import { hasServiceAccess } from "@/lib/introduction/service-access";

interface NewMemberRow {
  id: string;
  name: string;
  email: string;
  dateJoined: string;
  country: string;
  city: string;
  postCode: string;
  stripeCustomerId: string;
}

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  return String(v).trim();
}

function localIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Date-only key from an Airtable date value (date or datetime). */
function dateKey(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  const key = raw.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
}

export async function GET(request: NextRequest) {
  try {
    await requireOpsViewer();
    const token = process.env.AIRTABLE_GET_DATA_TOKEN;
    const baseId = process.env.AIRTABLE_BASE_ID;

    if (!token || !baseId) {
      return NextResponse.json(
        { success: false, error: "Missing Airtable credentials" },
        { status: 500 }
      );
    }

    const today = new Date();
    const defaultStart = localIso(new Date(today.getTime() - 6 * 86400000));
    const defaultEnd = localIso(today);
    const rawStart = request.nextUrl.searchParams.get("startDate");
    const rawEnd = request.nextUrl.searchParams.get("endDate");
    const effectiveStart =
      rawStart && /^\d{4}-\d{2}-\d{2}$/.test(rawStart) ? rawStart : defaultStart;
    const effectiveEnd =
      rawEnd && /^\d{4}-\d{2}-\d{2}$/.test(rawEnd) ? rawEnd : defaultEnd;

    const client = createAirtableClient({ apiKey: token, baseId });

    const memberFields = [
      MEMBER_FIELDS.name,
      MEMBER_FIELDS.email,
      MEMBER_FIELDS.dateJoined,
      MEMBER_FIELDS.city,
      MEMBER_FIELDS.cityRelation,
      MEMBER_FIELDS.postCode,
      MEMBER_FIELDS.stripeCustomerId,
      MEMBER_FIELDS.membership,
      MEMBER_FIELDS.payment,
      MEMBER_FIELDS.serviceAccessUntil,
    ];

    let memberRecords;
    try {
      memberRecords = await client.listRecords(MEMBERS_TABLE, {
        fields: memberFields,
      });
    } catch (e) {
      const schema = toAirtableSchemaError(MEMBERS_TABLE, e);
      if (schema?.field === MEMBER_FIELDS.cityRelation) {
        memberRecords = await client.listRecords(MEMBERS_TABLE, {
          fields: memberFields.filter((f) => f !== MEMBER_FIELDS.cityRelation),
        });
      } else {
        throw e;
      }
    }

    const cityRecords = await client.listRecords(CITIES_TABLE, {
      fields: [CITY_FIELDS.city, CITY_FIELDS.country],
    });
    const citiesById = new Map(cityRecords.map((c) => [c.id, c]));
    const countryByCityName = new Map<string, string>();
    for (const c of cityRecords) {
      const key = normalizeCityKey(fieldStr(c.fields, CITY_FIELDS.city));
      const country = fieldStr(c.fields, CITY_FIELDS.country);
      if (key && country && !countryByCityName.has(key)) {
        countryByCityName.set(key, country);
      }
    }

    const referenceDate = new Date();
    const members: NewMemberRow[] = [];

    for (const r of memberRecords) {
      const membership = fieldStr(r.fields, MEMBER_FIELDS.membership);
      const payment = fieldStr(r.fields, MEMBER_FIELDS.payment);
      const until = fieldStr(r.fields, MEMBER_FIELDS.serviceAccessUntil) || null;
      if (!hasServiceAccess(membership, payment, until, referenceDate)) continue;

      const joined = dateKey(fieldStr(r.fields, MEMBER_FIELDS.dateJoined));
      if (!joined || joined < effectiveStart || joined > effectiveEnd) continue;

      const linkIds = linkedRecordIds(r.fields, MEMBER_FIELDS.cityRelation);
      let city = fieldStr(r.fields, MEMBER_FIELDS.city);
      let country = "";
      for (const id of linkIds) {
        const rec = citiesById.get(id);
        if (!rec) continue;
        const name = fieldStr(rec.fields, CITY_FIELDS.city);
        if (name) city = name;
        const ct = fieldStr(rec.fields, CITY_FIELDS.country);
        if (ct) country = ct;
        break;
      }
      if (!country) {
        country = countryByCityName.get(normalizeCityKey(city)) || "";
      }

      members.push({
        id: r.id,
        name: fieldStr(r.fields, MEMBER_FIELDS.name),
        email: fieldStr(r.fields, MEMBER_FIELDS.email),
        dateJoined: joined,
        country,
        city,
        postCode: fieldStr(r.fields, MEMBER_FIELDS.postCode),
        stripeCustomerId: fieldStr(r.fields, MEMBER_FIELDS.stripeCustomerId),
      });
    }

    members.sort(
      (a, b) =>
        b.dateJoined.localeCompare(a.dateJoined) || a.name.localeCompare(b.name)
    );

    return NextResponse.json({
      success: true,
      startDate: effectiveStart,
      endDate: effectiveEnd,
      total: members.length,
      members,
    });
  } catch (err) {
    const ops = handleOpsApiError(err);
    if (ops.status === 401 || ops.status === 403) return ops;
    console.error("[API] get-daily-new-customers-for-cities error:", err);
    return NextResponse.json(
      { success: false, error: String(err) },
      { status: 500 }
    );
  }
}
