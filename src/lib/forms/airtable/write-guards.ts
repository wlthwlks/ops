import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

/**
 * Airtable `Name` is a computed formula field — never include it in create/update payloads.
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
  delete out["Help wanted"];
  delete out["Expertise offered"];
  return out;
}
