/**
 * Live COUNTRIES + ALL CITIES catalogue from Airtable.
 * Eligibility: COUNTRIES.Active === true AND ALL CITIES["Form enabled"] === true
 * plus a valid Country linked-record relationship.
 * City/country codes are Airtable record IDs for MEMBERS.City relation.
 */
import {
  createAirtableClient,
  type AirtableClient,
  type AirtableRecord,
} from "@/lib/integrations/airtable";
import {
  CITIES_TABLE,
  CITY_FIELDS,
  COUNTRIES_TABLE,
} from "@/lib/ops/airtable-fields";

export type CatalogCountry = {
  code: string;
  label: string;
};

export type CatalogCity = {
  /** Airtable ALL CITIES record id — used as form cityCode */
  code: string;
  label: string;
  /** Airtable COUNTRIES record id — used as form countryCode */
  countryCode: string;
  countryLabel: string;
  timezone: string;
  /** Exact City text column value for MEMBERS.City */
  legacyCityLabel: string;
  airtableRecordId: string;
  hasSlackChannel: boolean;
  cityTier: string;
  formEnabled: boolean;
};

export type LocationCatalog = {
  countries: CatalogCountry[];
  cities: CatalogCity[];
  source: "airtable" | "empty";
  fetchedAt: string;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; data: LocationCatalog } | null = null;

/** Default IANA timezone by COUNTRIES.Name when city has no Timezone value. */
const COUNTRY_TIMEZONE: Record<string, string> = {
  "United Kingdom": "Europe/London",
  Ireland: "Europe/Dublin",
  "United States": "America/New_York",
  Canada: "America/Toronto",
  Australia: "Australia/Sydney",
  UAE: "Asia/Dubai",
  Germany: "Europe/Berlin",
  France: "Europe/Paris",
  Spain: "Europe/Madrid",
  Portugal: "Europe/Lisbon",
  Netherlands: "Europe/Amsterdam",
  Italy: "Europe/Rome",
  Mexico: "America/Mexico_City",
  Brazil: "America/Sao_Paulo",
  "South Africa": "Africa/Johannesburg",
  Singapore: "Asia/Singapore",
  Japan: "Asia/Tokyo",
  India: "Asia/Kolkata",
  Malaysia: "Asia/Kuala_Lumpur",
  Vietnam: "Asia/Ho_Chi_Minh",
  Nigeria: "Africa/Lagos",
  Argentina: "America/Argentina/Buenos_Aires",
  Qatar: "Asia/Qatar",
  Virtual: "UTC",
};

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

function firstLinkId(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

/** Airtable checkbox → boolean (true only for real boolean true or 1). */
export function isAirtableChecked(value: unknown): boolean {
  return value === true || value === 1;
}

function getClient(): AirtableClient | null {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) return null;
  return createAirtableClient({ apiKey: token, baseId });
}

export function clearLocationCatalogCache(): void {
  cache = null;
}

export async function loadLocationCatalog(
  airtable: AirtableClient | null = getClient(),
  opts?: { force?: boolean }
): Promise<LocationCatalog> {
  if (!opts?.force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  if (!airtable) {
    const empty: LocationCatalog = {
      countries: [],
      cities: [],
      source: "empty",
      fetchedAt: new Date().toISOString(),
    };
    return empty;
  }

  // Only request verified live fields (unknown fields[] → Airtable 422).
  const [countryRecs, cityRecs] = await Promise.all([
    airtable.listRecords(COUNTRIES_TABLE, {
      fields: ["Name", "Active", "ALL CITIES"],
    }),
    airtable.listRecords(CITIES_TABLE, {
      fields: [
        CITY_FIELDS.city,
        "Country",
        "Form enabled",
        CITY_FIELDS.slackChannels,
        "City Tier",
      ],
    }),
  ]);

  const countriesById = new Map<string, CatalogCountry>();
  for (const r of countryRecs) {
    if (!isAirtableChecked(r.fields.Active)) continue;
    const label = fieldStr(r.fields, "Name");
    if (!label) continue;
    countriesById.set(r.id, { code: r.id, label });
  }

  const cities: CatalogCity[] = [];
  for (const r of cityRecs) {
    if (!isAirtableChecked(r.fields["Form enabled"])) continue;
    const label = fieldStr(r.fields, CITY_FIELDS.city);
    if (!label) continue;
    const countryId = firstLinkId(r.fields, "Country");
    const country = countryId ? countriesById.get(countryId) : undefined;
    if (!country) continue; // requires active country link

    const timezone = COUNTRY_TIMEZONE[country.label] || "";
    const slack = r.fields[CITY_FIELDS.slackChannels];
    const hasSlackChannel = Array.isArray(slack) && slack.length > 0;

    cities.push({
      code: r.id,
      label,
      countryCode: country.code,
      countryLabel: country.label,
      timezone,
      legacyCityLabel: label,
      airtableRecordId: r.id,
      hasSlackChannel,
      cityTier: fieldStr(r.fields, "City Tier"),
      formEnabled: true,
    });
  }

  const usedCountryIds = new Set(cities.map((c) => c.countryCode));
  const countries = [...countriesById.values()]
    .filter((c) => usedCountryIds.has(c.code))
    .sort((a, b) => a.label.localeCompare(b.label));

  cities.sort((a, b) => a.label.localeCompare(b.label));

  const data: LocationCatalog = {
    countries,
    cities,
    source: "airtable",
    fetchedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), data };
  return data;
}

export async function findCatalogCityByCode(
  code: string,
  airtable?: AirtableClient | null
): Promise<CatalogCity | undefined> {
  const id = code.trim();
  if (!id) return undefined;
  const catalog = await loadLocationCatalog(airtable ?? getClient());
  return catalog.cities.find((c) => c.code === id || c.airtableRecordId === id);
}

export async function findCatalogCityByRecordIds(
  recordIds: string[],
  airtable?: AirtableClient | null
): Promise<CatalogCity | undefined> {
  if (!recordIds.length) return undefined;
  const catalog = await loadLocationCatalog(airtable ?? getClient());
  for (const id of recordIds) {
    const hit = catalog.cities.find((c) => c.code === id);
    if (hit) return hit;
  }
  return undefined;
}

export function isAirtableRecordId(value: string): boolean {
  return /^rec[a-zA-Z0-9]{10,}$/.test(value.trim());
}

/** Map MEMBERS City relation / City text → form codes using live catalogue. */
export async function resolveMemberLocationDto(
  fields: Record<string, unknown>,
  airtable?: AirtableClient | null
): Promise<{ cityCode: string; countryCode: string; city: string }> {
  const cityText = fieldStr(fields, "City");
  const rel = fields["City relation"];
  const relIds = Array.isArray(rel)
    ? rel.filter((x): x is string => typeof x === "string")
    : [];

  const byRel = await findCatalogCityByRecordIds(relIds, airtable);
  if (byRel) {
    return {
      cityCode: byRel.code,
      countryCode: byRel.countryCode,
      city: byRel.label,
    };
  }

  if (cityText) {
    const catalog = await loadLocationCatalog(airtable ?? getClient());
    const byName = catalog.cities.find(
      (c) => c.label.toLowerCase() === cityText.toLowerCase()
    );
    if (byName) {
      return {
        cityCode: byName.code,
        countryCode: byName.countryCode,
        city: byName.label,
      };
    }
  }

  return { cityCode: relIds[0] || "", countryCode: "", city: cityText };
}

/** Test helper — inject catalogue without Airtable. */
export function setLocationCatalogForTests(data: LocationCatalog | null): void {
  if (!data) {
    cache = null;
    return;
  }
  cache = { at: Date.now(), data };
}

export type { AirtableRecord };
