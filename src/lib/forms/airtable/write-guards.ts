import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

/**
 * Airtable `Name` is a computed formula field — never include it in create/update payloads.
 * Also strips known obsolete / app-only keys that must never hit Airtable.
 */
export function stripComputedMemberWriteFields(
  fields: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...fields };
  delete out[MEMBER_FIELDS.name];
  delete out.Name;
  delete out.name;
  // Nonexistent / removed columns
  delete out["Last form source"];
  delete out.lastFormSource;
  delete out["Country code"];
  delete out["City code"];
  delete out["Primary industry"];
  delete out["Annual revenue"];
  delete out["90-day goal"];
  delete out["Availability codes"];
  delete out["First attribution at"];
  delete out.utm_source;
  delete out.utm_medium;
  delete out.utm_campaign;
  delete out.utm_content;
  delete out.utm_term;
  delete out["Business name"];
  delete out["Business website"];
  // Obsolete name — correct field is "Expertise"
  delete out["Expertise offered"];
  // App-only keys (never Airtable columns)
  delete out.otherIndustry;
  delete out.expertiseOffered;
  delete out.primaryIndustry;
  delete out.annualRevenue;
  delete out.helpWanted; // app key — Airtable uses "Help wanted" via MEMBER_FIELDS
  delete out.phonePrefix; // app key — Airtable uses "Phone prefix"
  delete out.countryIso2; // validation-only, never Airtable
  delete out.postCode; // app key — Airtable uses "post code" via MEMBER_FIELDS
  return out;
}
