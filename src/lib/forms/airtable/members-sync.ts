/**
 * Centralized Airtable member sync for forms/webhooks.
 * Field names must match canonical MEMBERS schema exactly.
 * NEVER writes computed Name. NEVER writes nonexistent columns.
 */
import {
  createAirtableClient,
  type AirtableClient,
  type AirtableRecord,
} from "@/lib/integrations/airtable";
import {
  MEMBER_FIELDS,
  MEMBERS_TABLE,
  sanitizeMembersWriteFields,
  toAirtableSchemaError,
} from "@/lib/ops/airtable-fields";
import { normalizeEmailStrict } from "@/lib/billing/reconcile-stripe-customers";
import {
  availabilityCodesToLegacyString,
  findCatalogCityByCode,
  resolveMemberLocationDto,
} from "@/lib/forms/reference-data";
import { FormsError } from "@/lib/forms/errors";
import { canWriteAirtableFromForms } from "@/lib/forms/feature-flags";
import { stripComputedMemberWriteFields } from "@/lib/forms/airtable/write-guards";

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
      throw new FormsError("AIRTABLE_VALIDATION_FAILED", schema.message, {
        status: 422,
        details: { field: schema.field },
      });
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

async function writeMembers(
  airtable: AirtableClient,
  mode: "create" | "update",
  fields: Record<string, unknown>,
  recordId?: string
): Promise<AirtableRecord> {
  const safe = sanitizeMembersWriteFields(
    stripComputedMemberWriteFields(fields),
    mode
  );
  // typecast: Industry/Revenue single-selects may not have options pre-created
  const writeOpts = { typecast: true as const };
  if (mode === "create") {
    const [created] = await airtable.createRecords(
      MEMBERS_TABLE,
      [{ fields: safe }],
      writeOpts
    );
    return created;
  }
  const [updated] = await airtable.updateRecords(
    MEMBERS_TABLE,
    [{ id: recordId!, fields: safe }],
    writeOpts
  );
  return updated;
}

/** Resolve form cityCode (ALL CITIES record id) → City text + City relation + Timezone. */
async function applyLocationPatch(
  fields: Record<string, unknown>,
  patch: Record<string, unknown>,
  airtable: AirtableClient
): Promise<void> {
  const cityCodeVal = patch._appCityCode ?? patch.cityCode;
  if (typeof cityCodeVal !== "string" || !cityCodeVal.trim()) {
    delete fields._appCityCode;
    delete fields.cityCode;
    delete fields.countryCode;
    return;
  }

  const city = await findCatalogCityByCode(cityCodeVal.trim(), airtable);
  if (!city) {
    throw new FormsError(
      "PROFILE_VALIDATION_FAILED",
      "Unknown city — choose a city from the list",
      { status: 400, details: { field: "cityCode", cityCode: cityCodeVal } }
    );
  }

  const countryCodeVal = patch._appCountryCode ?? patch.countryCode;
  if (
    typeof countryCodeVal === "string" &&
    countryCodeVal.trim() &&
    countryCodeVal.trim() !== city.countryCode
  ) {
    throw new FormsError(
      "PROFILE_VALIDATION_FAILED",
      "City does not match country",
      { status: 400, details: { field: "cityCode" } }
    );
  }

  fields[MEMBER_FIELDS.city] = city.legacyCityLabel;
  fields[MEMBER_FIELDS.cityRelation] = [city.airtableRecordId];
  if (city.timezone) {
    fields[MEMBER_FIELDS.timezone] = city.timezone;
  }

  delete fields._appCityCode;
  delete fields._appCountryCode;
  delete fields.cityCode;
  delete fields.countryCode;
}

function applyAvailabilityPatch(
  fields: Record<string, unknown>,
  patch: Record<string, unknown>
): void {
  const avail = patch[MEMBER_FIELDS.availabilityV2] ?? patch.availability;
  if (Array.isArray(avail)) {
    const codes = (avail as string[]).map((c) => String(c).trim()).filter(Boolean);
    // multi-select: string[] of option names (mon_morning, …)
    fields[MEMBER_FIELDS.availabilityV2] = codes;
    fields[MEMBER_FIELDS.availabilityLegacy] = availabilityCodesToLegacyString(codes);
    delete fields.availability;
  } else if (typeof avail === "string" && avail.trim()) {
    const codes = avail
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    fields[MEMBER_FIELDS.availabilityV2] = codes;
    fields[MEMBER_FIELDS.availabilityLegacy] = availabilityCodesToLegacyString(codes);
    delete fields.availability;
  }
}

export async function upsertMinimalSignupMember(
  input: MinimalSignupInput,
  airtable: AirtableClient = getFormsAirtableClient()
): Promise<{ record: AirtableRecord; created: boolean; shadowed: boolean }> {
  const email = normalizeEmailStrict(input.email);

  const existing =
    requireUnique(
      await findMemberByMemberstackId(input.memberstackId, airtable),
      "Memberstack ID"
    ) ||
    requireUnique(
      await findMemberByNormalizedEmailForSignupRecovery(email, airtable),
      "email"
    );

  const fields: Record<string, unknown> = {
    [MEMBER_FIELDS.email]: email,
    [MEMBER_FIELDS.memberstackId]: input.memberstackId,
    [MEMBER_FIELDS.firstName]: input.firstName,
    [MEMBER_FIELDS.lastName]: input.lastName,
    [MEMBER_FIELDS.onboardingStatus]: existing
      ? fieldStr(existing.fields, MEMBER_FIELDS.onboardingStatus) || "ACCOUNT_CREATED"
      : "ACCOUNT_CREATED",
    [MEMBER_FIELDS.lastCompletedSignupStep]: "ACCOUNT",
  };

  // First-touch attribution only on create — exact canonical UTM field names
  if (!existing && input.attribution) {
    const a = input.attribution;
    if (a.utm_source) fields[MEMBER_FIELDS.utmSource] = a.utm_source;
    if (a.utm_medium) fields[MEMBER_FIELDS.utmMedium] = a.utm_medium;
    if (a.utm_campaign) fields[MEMBER_FIELDS.utmCampaign] = a.utm_campaign;
    if (a.utm_content) fields[MEMBER_FIELDS.utmContent] = a.utm_content;
    if (a.utm_term) fields[MEMBER_FIELDS.utmTerm] = a.utm_term;
    if (a.gclid) fields[MEMBER_FIELDS.googleClickId] = a.gclid;
    if (a.fbclid) fields[MEMBER_FIELDS.facebookClickId] = a.fbclid;
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
      const updated = await writeMembers(airtable, "update", fields, existing.id);
      return { record: updated, created: false, shadowed: false };
    }
    const created = await writeMembers(airtable, "create", fields);
    return { record: created, created: true, shadowed: false };
  } catch (e) {
    if (e instanceof Error && e.message.includes("Unsupported Airtable field")) {
      throw new FormsError("AIRTABLE_VALIDATION_FAILED", e.message, { status: 422 });
    }
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
    [MEMBER_FIELDS.lastCompletedSignupStep]: input.stage,
    [MEMBER_FIELDS.profileLastUpdatedAt]: new Date().toISOString(),
  };

  await applyLocationPatch(fields, input.patch, airtable);
  applyAvailabilityPatch(fields, input.patch);

  // Drop app-only keys that are not Airtable MEMBERS columns
  delete fields.countryCode;
  delete fields.cityCode;
  delete fields._appCityCode;
  delete fields._appCountryCode;
  delete fields.helpWanted;
  delete fields.expertiseOffered;
  delete fields.businessName;
  delete fields.businessWebsite;
  delete fields.primaryIndustry;
  delete fields.annualRevenue;

  const writeFields = stripComputedMemberWriteFields(fields);

  // Payment confirmation must land even when other form writes are shadowed:
  // invoice.paid only matches Stripe Customer ID (often blank until later).
  const isPaymentConfirm =
    input.stage === "PAYMENT_CONFIRMED" ||
    writeFields[MEMBER_FIELDS.payment] === "Paid";
  const allowWrite =
    canWriteAirtableFromForms() ||
    (isPaymentConfirm &&
      ((process.env.MAKE_SHADOW_MODE || "").toLowerCase() !== "true" &&
        (process.env.MAKE_SHADOW_MODE || "") !== "1"));

  if (!allowWrite) {
    return {
      record: { ...existing, fields: { ...existing.fields, ...writeFields } },
      shadowed: true,
    };
  }

  try {
    const updated = await writeMembers(airtable, "update", writeFields, existing.id);
    return { record: updated, shadowed: false };
  } catch (e) {
    if (e instanceof Error && e.message.includes("Unsupported Airtable field")) {
      throw new FormsError("AIRTABLE_VALIDATION_FAILED", e.message, { status: 422 });
    }
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

  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.patch)) {
    if (v === undefined || v === null) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    fields[k] = v;
  }
  fields[MEMBER_FIELDS.profileLastUpdatedAt] = new Date().toISOString();

  await applyLocationPatch(fields, input.patch, airtable);
  applyAvailabilityPatch(fields, {
    ...input.patch,
    [MEMBER_FIELDS.availabilityV2]:
      fields[MEMBER_FIELDS.availabilityV2] ?? input.patch[MEMBER_FIELDS.availabilityV2],
    availability: fields.availability ?? input.patch.availability,
  });

  delete fields._appCityCode;
  delete fields._appCountryCode;
  delete fields.cityCode;
  delete fields.countryCode;
  delete fields.helpWanted;
  delete fields.expertiseOffered;
  delete fields.businessName;
  delete fields.businessWebsite;
  delete fields.primaryIndustry;
  delete fields.annualRevenue;
  delete fields.availability;

  const writeFields = stripComputedMemberWriteFields(fields);

  if (!canWriteAirtableFromForms()) {
    return {
      record: { ...existing, fields: { ...existing.fields, ...writeFields } },
      shadowed: true,
    };
  }

  const updated = await writeMembers(airtable, "update", writeFields, existing.id);
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
      "Stripe Customer ID assigned to multiple Airtable records",
      { status: 409, details: { ids: matches.map((m) => m.id) } }
    );
  }
  const existing = matches[0];
  const writeEnabled =
    canWriteAirtableFromForms() ||
    (process.env.NEW_STRIPE_WEBHOOKS_ENABLED || "").toLowerCase() === "true" ||
    (process.env.NEW_STRIPE_WEBHOOKS_ENABLED || "") === "1";

  if (!writeEnabled) {
    return { record: existing, status: "shadowed" };
  }

  const updated = await writeMembers(
    airtable,
    "update",
    stripComputedMemberWriteFields(input.patch),
    existing.id
  );
  return { record: updated, status: "updated" };
}

export function recordToProfileDto(record: AirtableRecord) {
  const f = record.fields;
  const availRaw = f[MEMBER_FIELDS.availabilityV2];
  const availability = Array.isArray(availRaw)
    ? availRaw.map((s) => String(s).trim()).filter(Boolean)
    : fieldStr(f, MEMBER_FIELDS.availabilityV2)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  const rel = f[MEMBER_FIELDS.cityRelation];
  const relId =
    Array.isArray(rel) && typeof rel[0] === "string" ? (rel[0] as string) : "";

  return {
    airtableRecordId: record.id,
    name: fieldStr(f, MEMBER_FIELDS.name),
    firstName: fieldStr(f, MEMBER_FIELDS.firstName),
    lastName: fieldStr(f, MEMBER_FIELDS.lastName),
    email: fieldStr(f, MEMBER_FIELDS.email),
    phone: fieldStr(f, MEMBER_FIELDS.phone),
    city: fieldStr(f, MEMBER_FIELDS.city),
    cityCode: relId,
    countryCode: "",
    membership: fieldStr(f, MEMBER_FIELDS.membership),
    payment: fieldStr(f, MEMBER_FIELDS.payment),
    serviceAccessUntil: fieldStr(f, MEMBER_FIELDS.serviceAccessUntil),
    cancellationDate: fieldStr(f, MEMBER_FIELDS.cancellationDate),
    cancelAtPeriodEnd: fieldStr(f, MEMBER_FIELDS.cancelAtPeriodEnd),
    cancellationEffectiveAt: fieldStr(f, MEMBER_FIELDS.cancellationEffectiveAt),
    stripeCustomerId: fieldStr(f, MEMBER_FIELDS.stripeCustomerId),
    memberstackId: fieldStr(f, MEMBER_FIELDS.memberstackId),
    onboardingStatus: fieldStr(f, MEMBER_FIELDS.onboardingStatus),
    businessName: "",
    businessWebsite: "",
    primaryIndustry: fieldStr(f, MEMBER_FIELDS.industry),
    businessStage: fieldStr(f, MEMBER_FIELDS.businessStage),
    annualRevenue: fieldStr(f, MEMBER_FIELDS.revenue),
    businessDescription: fieldStr(f, MEMBER_FIELDS.businessDescription),
    ninetyDayGoal: fieldStr(f, MEMBER_FIELDS.ninetyDayGoal),
    helpWanted: [] as string[],
    helpWantedContext: fieldStr(f, MEMBER_FIELDS.helpWantedContext),
    expertiseOffered: [] as string[],
    expertiseContext: fieldStr(f, MEMBER_FIELDS.expertiseContext),
    connectionType: fieldStr(f, MEMBER_FIELDS.connectionType),
    availability,
  };
}

/** Async profile DTO with country resolved from live catalogue. */
export async function recordToProfileDtoResolved(
  record: AirtableRecord,
  airtable: AirtableClient = getFormsAirtableClient()
) {
  const base = recordToProfileDto(record);
  const loc = await resolveMemberLocationDto(record.fields, airtable);
  return {
    ...base,
    city: loc.city || base.city,
    cityCode: loc.cityCode || base.cityCode,
    countryCode: loc.countryCode || base.countryCode,
  };
}

// Re-export for tests
export { stripComputedMemberWriteFields } from "@/lib/forms/airtable/write-guards";
