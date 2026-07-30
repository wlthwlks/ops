/**
 * Centralized Airtable member sync for forms/webhooks.
 * Does NOT touch matching, introductions, or Pinecone fields.
 * Stripe webhooks never create members and never use email fallback.
 */
import { createAirtableClient, type AirtableClient, type AirtableRecord } from "@/lib/integrations/airtable";
import {
  MEMBER_FIELDS,
  MEMBERS_TABLE,
  toAirtableSchemaError,
} from "@/lib/ops/airtable-fields";
import { normalizeEmailStrict } from "@/lib/billing/reconcile-stripe-customers";
import {
  availabilityCodesToLegacyString,
  findCityByCode,
} from "@/lib/forms/reference-data";
import { FormsError } from "@/lib/forms/errors";
import { canWriteAirtableFromForms } from "@/lib/forms/feature-flags";

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

function escapeFormula(value: string): string {
  return value.replace(/'/g, "\\'");
}

export function getFormsAirtableClient(): AirtableClient {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    throw new FormsError("AIRTABLE_AUTH_FAILED", "Airtable is not configured", {
      status: 500,
      retryable: false,
    });
  }
  return createAirtableClient({ apiKey: token, baseId });
}

export async function findMemberByMemberstackId(
  memberstackId: string,
  airtable: AirtableClient = getFormsAirtableClient()
): Promise<AirtableRecord[]> {
  const id = memberstackId.trim();
  if (!id) return [];
  try {
    return await airtable.listRecords(MEMBERS_TABLE, {
      filterByFormula: `{${MEMBER_FIELDS.memberstackId}} = '${escapeFormula(id)}'`,
      maxRecords: 5,
    });
  } catch (e) {
    const schema = toAirtableSchemaError(MEMBERS_TABLE, e);
    if (schema) {
      throw new FormsError(
        "AIRTABLE_VALIDATION_FAILED",
        schema.message,
        { status: 422, details: { field: schema.field } }
      );
    }
    throw e;
  }
}

export async function findMemberByStripeCustomerId(
  stripeCustomerId: string,
  airtable: AirtableClient = getFormsAirtableClient()
): Promise<AirtableRecord[]> {
  const id = stripeCustomerId.trim();
  if (!id.startsWith("cus_")) return [];
  return airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `{${MEMBER_FIELDS.stripeCustomerId}} = '${escapeFormula(id)}'`,
    maxRecords: 5,
  });
}

/** Signup recovery only — never used by Stripe webhooks. */
export async function findMemberByNormalizedEmailForSignupRecovery(
  email: string,
  airtable: AirtableClient = getFormsAirtableClient()
): Promise<AirtableRecord[]> {
  const n = normalizeEmailStrict(email);
  if (!n) return [];
  return airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `LOWER({${MEMBER_FIELDS.email}}) = '${escapeFormula(n)}'`,
    maxRecords: 5,
  });
}

function requireUnique(
  records: AirtableRecord[],
  context: string
): AirtableRecord | null {
  if (records.length === 0) return null;
  if (records.length > 1) {
    throw new FormsError(
      "AIRTABLE_DUPLICATE_MEMBER",
      `Duplicate Airtable members for ${context}`,
      {
        status: 409,
        details: { ids: records.map((r) => r.id) },
      }
    );
  }
  return records[0];
}

export type MinimalSignupInput = {
  memberstackId: string;
  email: string;
  firstName: string;
  lastName: string;
  attribution?: Record<string, string | undefined>;
  source?: string;
};

export async function upsertMinimalSignupMember(
  input: MinimalSignupInput,
  airtable: AirtableClient = getFormsAirtableClient()
): Promise<{ record: AirtableRecord; created: boolean; shadowed: boolean }> {
  const email = normalizeEmailStrict(input.email);
  const name = `${input.firstName} ${input.lastName}`.trim();

  let existing =
    requireUnique(
      await findMemberByMemberstackId(input.memberstackId, airtable),
      "Memberstack ID"
    ) ||
    requireUnique(
      await findMemberByNormalizedEmailForSignupRecovery(email, airtable),
      "email"
    );

  const fields: Record<string, unknown> = {
    [MEMBER_FIELDS.name]: name,
    [MEMBER_FIELDS.email]: email,
    [MEMBER_FIELDS.memberstackId]: input.memberstackId,
    [MEMBER_FIELDS.firstName]: input.firstName,
    [MEMBER_FIELDS.lastName]: input.lastName,
    [MEMBER_FIELDS.onboardingStatus]: existing
      ? fieldStr(existing.fields, MEMBER_FIELDS.onboardingStatus) || "ACCOUNT_CREATED"
      : "ACCOUNT_CREATED",
    [MEMBER_FIELDS.lastFormSource]: input.source || "signup_widget",
  };

  if (!existing && input.attribution) {
    const a = input.attribution;
    if (a.utm_source) fields[MEMBER_FIELDS.utmSource] = a.utm_source;
    if (a.utm_medium) fields[MEMBER_FIELDS.utmMedium] = a.utm_medium;
    if (a.utm_campaign) fields[MEMBER_FIELDS.utmCampaign] = a.utm_campaign;
    if (a.utm_content) fields[MEMBER_FIELDS.utmContent] = a.utm_content;
    if (a.utm_term) fields[MEMBER_FIELDS.utmTerm] = a.utm_term;
    if (a.initialLandingPage) fields[MEMBER_FIELDS.initialLandingPage] = a.initialLandingPage;
    if (a.initialReferrer) fields[MEMBER_FIELDS.initialReferrer] = a.initialReferrer;
    if (a.firstAttributionAt) fields[MEMBER_FIELDS.firstAttributionAt] = a.firstAttributionAt;
  }

  if (!canWriteAirtableFromForms()) {
    return {
      record: existing || { id: "shadow", fields },
      created: !existing,
      shadowed: true,
    };
  }

  try {
    if (existing) {
      const [updated] = await airtable.updateRecords(MEMBERS_TABLE, [
        { id: existing.id, fields },
      ]);
      return { record: updated, created: false, shadowed: false };
    }
    const [created] = await airtable.createRecords(MEMBERS_TABLE, [{ fields }]);
    return { record: created, created: true, shadowed: false };
  } catch (e) {
    const schema = toAirtableSchemaError(MEMBERS_TABLE, e);
    if (schema) {
      throw new FormsError("AIRTABLE_VALIDATION_FAILED", schema.message, {
        status: 422,
        details: { field: schema.field },
      });
    }
    throw new FormsError(
      "AIRTABLE_WRITE_FAILED",
      e instanceof Error ? e.message : "Airtable write failed",
      { status: 502, retryable: true }
    );
  }
}

export async function updateOnboardingStep(
  input: {
    memberstackId: string;
    stage: string;
    patch: Record<string, unknown>;
  },
  airtable: AirtableClient = getFormsAirtableClient()
): Promise<{ record: AirtableRecord | null; shadowed: boolean }> {
  const existing = requireUnique(
    await findMemberByMemberstackId(input.memberstackId, airtable),
    "Memberstack ID"
  );
  if (!existing) {
    throw new FormsError("AIRTABLE_MEMBER_NOT_FOUND", "Member not found for Memberstack ID", {
      status: 404,
    });
  }

  const fields: Record<string, unknown> = {
    ...input.patch,
    [MEMBER_FIELDS.onboardingStatus]: input.stage,
    [MEMBER_FIELDS.lastFormSource]: "signup_widget",
  };

  // Expand city code → legacy city + geo metadata fields when present
  if (typeof input.patch[MEMBER_FIELDS.cityCode] === "string") {
    const city = findCityByCode(String(input.patch[MEMBER_FIELDS.cityCode]));
    if (city) {
      fields[MEMBER_FIELDS.city] = city.legacyCityLabel;
      fields[MEMBER_FIELDS.countryCode] = city.countryCode;
    }
  }
  if (Array.isArray(input.patch[MEMBER_FIELDS.availabilityCodes])) {
    const codes = input.patch[MEMBER_FIELDS.availabilityCodes] as string[];
    fields[MEMBER_FIELDS.availabilityLegacy] = availabilityCodesToLegacyString(codes);
    fields[MEMBER_FIELDS.availabilityCodes] = codes.join(",");
  }

  if (!canWriteAirtableFromForms()) {
    return { record: { ...existing, fields: { ...existing.fields, ...fields } }, shadowed: true };
  }

  try {
    const [updated] = await airtable.updateRecords(MEMBERS_TABLE, [
      { id: existing.id, fields },
    ]);
    return { record: updated, shadowed: false };
  } catch (e) {
    const schema = toAirtableSchemaError(MEMBERS_TABLE, e);
    if (schema) {
      // Retry without unknown optional fields
      const msg = schema.message;
      throw new FormsError("AIRTABLE_VALIDATION_FAILED", msg, {
        status: 422,
        details: { field: schema.field },
      });
    }
    throw new FormsError(
      "AIRTABLE_WRITE_FAILED",
      e instanceof Error ? e.message : "Airtable write failed",
      { status: 502, retryable: true }
    );
  }
}

export async function updateMemberProfile(
  input: {
    memberstackId: string;
    patch: Record<string, unknown>;
  },
  airtable: AirtableClient = getFormsAirtableClient()
): Promise<{ record: AirtableRecord; shadowed: boolean }> {
  const existing = requireUnique(
    await findMemberByMemberstackId(input.memberstackId, airtable),
    "Memberstack ID"
  );
  if (!existing) {
    throw new FormsError("AIRTABLE_MEMBER_NOT_FOUND", "Member not found", { status: 404 });
  }

  // Never blank out with empty strings for profile sync from MS
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.patch)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    fields[k] = v;
  }
  fields[MEMBER_FIELDS.lastFormSource] = "update_details_widget";

  if (typeof fields[MEMBER_FIELDS.cityCode] === "string") {
    const city = findCityByCode(String(fields[MEMBER_FIELDS.cityCode]));
    if (city) {
      fields[MEMBER_FIELDS.city] = city.legacyCityLabel;
      fields[MEMBER_FIELDS.countryCode] = city.countryCode;
    }
  }
  if (Array.isArray(fields[MEMBER_FIELDS.availabilityCodes])) {
    const codes = fields[MEMBER_FIELDS.availabilityCodes] as string[];
    fields[MEMBER_FIELDS.availabilityLegacy] = availabilityCodesToLegacyString(codes);
    fields[MEMBER_FIELDS.availabilityCodes] = codes.join(",");
  }
  if (typeof fields[MEMBER_FIELDS.firstName] === "string" || typeof fields[MEMBER_FIELDS.lastName] === "string") {
    const fn =
      (fields[MEMBER_FIELDS.firstName] as string) ||
      fieldStr(existing.fields, MEMBER_FIELDS.firstName);
    const ln =
      (fields[MEMBER_FIELDS.lastName] as string) ||
      fieldStr(existing.fields, MEMBER_FIELDS.lastName);
    if (fn || ln) fields[MEMBER_FIELDS.name] = `${fn} ${ln}`.trim();
  }

  if (!canWriteAirtableFromForms()) {
    return {
      record: { ...existing, fields: { ...existing.fields, ...fields } },
      shadowed: true,
    };
  }

  const [updated] = await airtable.updateRecords(MEMBERS_TABLE, [
    { id: existing.id, fields },
  ]);
  return { record: updated, shadowed: false };
}

export async function updateMemberBilling(
  input: {
    stripeCustomerId: string;
    patch: Record<string, unknown>;
    allowCreate?: false;
  },
  airtable: AirtableClient = getFormsAirtableClient()
): Promise<{ record: AirtableRecord | null; status: string }> {
  const matches = await findMemberByStripeCustomerId(input.stripeCustomerId, airtable);
  if (matches.length === 0) {
    return { record: null, status: "STRIPE_MEMBER_NOT_FOUND" };
  }
  if (matches.length > 1) {
    throw new FormsError(
      "STRIPE_CUSTOMER_CONFLICT",
      "Stripe Customer ID assigned to multiple Airtable members",
      { status: 409, details: { ids: matches.map((m) => m.id) } }
    );
  }
  const existing = matches[0];
  if (!canWriteAirtableFromForms() && !process.env.NEW_STRIPE_WEBHOOKS_ENABLED) {
    // Billing via expanded webhooks uses its own flag; legacy invoice.paid uses separate path
  }
  const writeEnabled =
    canWriteAirtableFromForms() ||
    (process.env.NEW_STRIPE_WEBHOOKS_ENABLED || "").toLowerCase() === "true" ||
    (process.env.NEW_STRIPE_WEBHOOKS_ENABLED || "") === "1";

  if (!writeEnabled) {
    return { record: existing, status: "shadowed" };
  }

  const [updated] = await airtable.updateRecords(MEMBERS_TABLE, [
    { id: existing.id, fields: input.patch },
  ]);
  return { record: updated, status: "updated" };
}

export function recordToProfileDto(record: AirtableRecord) {
  const f = record.fields;
  return {
    airtableRecordId: record.id,
    name: fieldStr(f, MEMBER_FIELDS.name),
    firstName: fieldStr(f, MEMBER_FIELDS.firstName),
    lastName: fieldStr(f, MEMBER_FIELDS.lastName),
    email: fieldStr(f, MEMBER_FIELDS.email),
    phone: fieldStr(f, MEMBER_FIELDS.phone),
    city: fieldStr(f, MEMBER_FIELDS.city),
    cityCode: fieldStr(f, MEMBER_FIELDS.cityCode),
    countryCode: fieldStr(f, MEMBER_FIELDS.countryCode),
    membership: fieldStr(f, MEMBER_FIELDS.membership),
    payment: fieldStr(f, MEMBER_FIELDS.payment),
    serviceAccessUntil: fieldStr(f, MEMBER_FIELDS.serviceAccessUntil),
    cancellationDate: fieldStr(f, MEMBER_FIELDS.cancellationDate),
    cancelAtPeriodEnd: fieldStr(f, MEMBER_FIELDS.cancelAtPeriodEnd),
    cancellationEffectiveAt: fieldStr(f, MEMBER_FIELDS.cancellationEffectiveAt),
    stripeCustomerId: fieldStr(f, MEMBER_FIELDS.stripeCustomerId),
    memberstackId: fieldStr(f, MEMBER_FIELDS.memberstackId),
    onboardingStatus: fieldStr(f, MEMBER_FIELDS.onboardingStatus),
    businessName: fieldStr(f, MEMBER_FIELDS.businessName),
    businessWebsite: fieldStr(f, MEMBER_FIELDS.businessWebsite),
    primaryIndustry: fieldStr(f, MEMBER_FIELDS.primaryIndustry),
    businessStage: fieldStr(f, MEMBER_FIELDS.businessStage),
    annualRevenue: fieldStr(f, MEMBER_FIELDS.annualRevenue),
    businessDescription: fieldStr(f, MEMBER_FIELDS.businessDescription),
    ninetyDayGoal: fieldStr(f, MEMBER_FIELDS.ninetyDayGoal),
    helpWanted: fieldStr(f, MEMBER_FIELDS.helpWanted)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    helpWantedContext: fieldStr(f, MEMBER_FIELDS.helpWantedContext),
    expertiseOffered: fieldStr(f, MEMBER_FIELDS.expertiseOffered)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    expertiseContext: fieldStr(f, MEMBER_FIELDS.expertiseContext),
    connectionType: fieldStr(f, MEMBER_FIELDS.connectionType),
    availability: fieldStr(f, MEMBER_FIELDS.availabilityCodes)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
