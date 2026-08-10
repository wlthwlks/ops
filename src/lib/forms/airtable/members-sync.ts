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
  linkIdsFromField,
  resolveMemberLocationDto,
  splitIndustryForUi,
  splitStoredPhone,
} from "@/lib/forms/reference-data";
import { FormsError } from "@/lib/forms/errors";
import { canWriteAirtableFromForms } from "@/lib/forms/feature-flags";
import { stripComputedMemberWriteFields } from "@/lib/forms/airtable/write-guards";
import {
  parseSocialMediaField,
} from "@/lib/forms/validation/profile-urls";

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

/**
 * Map app matching selections → linked-record arrays on MEMBERS.
 * Accepts either Airtable field keys or app keys (helpWanted / expertiseOffered).
 * Empty arrays clear the linked field.
 */
function applyMatchingLinkedPatch(
  fields: Record<string, unknown>,
  patch: Record<string, unknown>
): void {
  const help =
    patch[MEMBER_FIELDS.helpWanted] ?? patch.helpWanted;
  if (Array.isArray(help)) {
    fields[MEMBER_FIELDS.helpWanted] = (help as unknown[])
      .map((c) => String(c).trim())
      .filter(Boolean);
    delete fields.helpWanted;
  }

  const expertise =
    patch[MEMBER_FIELDS.expertise] ?? patch.expertiseOffered ?? patch.expertise;
  if (Array.isArray(expertise)) {
    fields[MEMBER_FIELDS.expertise] = (expertise as unknown[])
      .map((c) => String(c).trim())
      .filter(Boolean);
    delete fields.expertiseOffered;
    delete fields.expertise;
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

  // New accounts only — never promote to Active/Paid from signup alone.
  // Airtable default Membership is Active when blank; always set Pending Payment on create.
  if (!existing) {
    fields[MEMBER_FIELDS.membership] = "Pending Payment";
    fields[MEMBER_FIELDS.payment] = "Unpaid";
  }

  // First-touch attribution: fill only blank first-touch fields (never overwrite).
  if (input.attribution) {
    const a = input.attribution;
    const src = existing?.fields || {};
    const setIfBlank = (field: string, value: string | undefined) => {
      if (!value) return;
      if (existing && fieldStr(src, field)) return;
      fields[field] = value;
    };
    setIfBlank(MEMBER_FIELDS.utmSource, a.utm_source);
    setIfBlank(MEMBER_FIELDS.utmMedium, a.utm_medium);
    setIfBlank(MEMBER_FIELDS.utmCampaign, a.utm_campaign);
    setIfBlank(MEMBER_FIELDS.utmContent, a.utm_content);
    setIfBlank(MEMBER_FIELDS.utmTerm, a.utm_term);
    setIfBlank(MEMBER_FIELDS.googleClickId, a.gclid);
    setIfBlank(MEMBER_FIELDS.facebookClickId, a.fbclid);
    setIfBlank(MEMBER_FIELDS.initialLandingPage, a.initialLandingPage);
    setIfBlank(MEMBER_FIELDS.initialReferrer, a.initialReferrer);
    setIfBlank(MEMBER_FIELDS.firstAttributionAt, a.firstAttributionAt);
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
  applyMatchingLinkedPatch(fields, input.patch);

  // Drop app-only keys that are not Airtable MEMBERS columns
  delete fields.countryCode;
  delete fields.cityCode;
  delete fields._appCityCode;
  delete fields._appCountryCode;
  delete fields._appProfessionalHeadline;
  delete fields._appProfileBio;
  delete fields.expertiseOffered;
  delete fields.businessName;
  delete fields.businessWebsite;
  delete fields.primaryIndustry;
  delete fields.annualRevenue;
  delete fields.otherIndustry;

  const writeFields = stripComputedMemberWriteFields(fields);

  // Client onboarding steps must never write Payment=Paid / Membership=Active.
  if (writeFields[MEMBER_FIELDS.payment] === "Paid") {
    delete writeFields[MEMBER_FIELDS.payment];
  }
  if (writeFields[MEMBER_FIELDS.membership] === "Active") {
    delete writeFields[MEMBER_FIELDS.membership];
  }

  if (!canWriteAirtableFromForms()) {
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

/**
 * Profile updates from trusted server callers (e.g. link Stripe Customer ID).
 * Does not strip Paid/Active — callers must be server-side only.
 */
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
    if (v === undefined) continue;
    // Explicit null clears to empty string; empty arrays clear linked multi-selects.
    if (v === null) {
      fields[k] = "";
      continue;
    }
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
  applyMatchingLinkedPatch(fields, input.patch);

  delete fields._appCityCode;
  delete fields._appCountryCode;
  delete fields._appProfessionalHeadline;
  delete fields._appProfileBio;
  delete fields.cityCode;
  delete fields.countryCode;
  delete fields.expertiseOffered;
  delete fields.businessName;
  delete fields.businessWebsite;
  delete fields.primaryIndustry;
  delete fields.annualRevenue;
  delete fields.otherIndustry;
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

function isMakeShadowMode(): boolean {
  const s = (process.env.MAKE_SHADOW_MODE || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

/** Billing writes always apply unless full shadow mode (same as invoice.paid). */
function canWriteBillingToAirtable(): boolean {
  if (isMakeShadowMode()) return false;
  return true;
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
  if (!canWriteBillingToAirtable()) {
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

/** Link Stripe Customer ID only (no Paid/Active) — unblocks invoice.paid matching. */
export async function linkStripeCustomerIdByMemberstackId(
  input: { memberstackId: string; stripeCustomerId: string },
  airtable: AirtableClient = getFormsAirtableClient()
): Promise<{ status: string }> {
  const msId = input.memberstackId.trim();
  const cus = input.stripeCustomerId.trim();
  if (!msId || !cus.startsWith("cus_")) return { status: "invalid_ids" };
  const existing = requireUnique(
    await findMemberByMemberstackId(msId, airtable),
    "Memberstack ID"
  );
  if (!existing) return { status: "AIRTABLE_MEMBER_NOT_FOUND" };
  if (!canWriteBillingToAirtable()) return { status: "shadowed" };
  await writeMembers(
    airtable,
    "update",
    { [MEMBER_FIELDS.stripeCustomerId]: cus },
    existing.id
  );
  return { status: "linked" };
}

/**
 * Trusted server path: link Stripe customer + mark paid by Memberstack ID.
 * Used after verifying Stripe Checkout Session or Memberstack plan payment.
 * Never creates members. Never matches by email alone for identity.
 */
export async function applyTrustedPaymentByMemberstackId(
  input: {
    memberstackId: string;
    stripeCustomerId: string;
    patch?: Record<string, unknown>;
  },
  airtable: AirtableClient = getFormsAirtableClient()
): Promise<{ record: AirtableRecord | null; status: string; shadowed: boolean }> {
  const msId = input.memberstackId.trim();
  const cus = input.stripeCustomerId.trim();
  if (!msId || !cus.startsWith("cus_")) {
    return { record: null, status: "invalid_ids", shadowed: false };
  }

  const existing = requireUnique(
    await findMemberByMemberstackId(msId, airtable),
    "Memberstack ID"
  );
  if (!existing) {
    return { record: null, status: "AIRTABLE_MEMBER_NOT_FOUND", shadowed: false };
  }

  // Conflict: another member already owns this Stripe customer
  const byCus = await findMemberByStripeCustomerId(cus, airtable);
  if (byCus.length > 0 && byCus.some((r) => r.id !== existing.id)) {
    throw new FormsError(
      "STRIPE_CUSTOMER_CONFLICT",
      "Stripe Customer ID assigned to another Airtable member",
      { status: 409, details: { ids: byCus.map((r) => r.id) } }
    );
  }

  const currentStatus = String(
    existing.fields[MEMBER_FIELDS.onboardingStatus] ?? ""
  ).trim();

  const patch: Record<string, unknown> = {
    [MEMBER_FIELDS.stripeCustomerId]: cus,
    [MEMBER_FIELDS.payment]: "Paid",
    [MEMBER_FIELDS.membership]: "Active",
    [MEMBER_FIELDS.billingLastSyncedAt]: new Date().toISOString(),
    ...(input.patch || {}),
  };
  if (currentStatus !== "COMPLETE") {
    patch[MEMBER_FIELDS.onboardingStatus] = "PAYMENT_CONFIRMED";
  }

  if (!canWriteBillingToAirtable()) {
    return {
      record: { ...existing, fields: { ...existing.fields, ...patch } },
      status: "shadowed",
      shadowed: true,
    };
  }

  const updated = await writeMembers(
    airtable,
    "update",
    stripComputedMemberWriteFields(patch),
    existing.id
  );
  return { record: updated, status: "updated", shadowed: false };
}

/** Legacy: codes embedded in context text — only extract known static codes. */
function parseLegacyCodesFromContext(
  context: string,
  knownCodes: Set<string>
): { codes: string[]; prose: string } {
  const parts = context
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const codes: string[] = [];
  const proseParts: string[] = [];
  for (const p of parts) {
    if (knownCodes.has(p)) codes.push(p);
    else proseParts.push(p);
  }
  return { codes, prose: proseParts.join(", ") };
}

const LEGACY_HELP_CODES = new Set([
  "GROWTH_MARKETING",
  "SALES",
  "PRODUCT",
  "FUNDRAISING",
  "OPERATIONS",
  "HIRING",
  "FINANCE",
  "TECHNOLOGY",
  "MINDSET",
  "NETWORKING",
]);
const LEGACY_EXPERTISE_CODES = new Set([
  "GROWTH_MARKETING",
  "SALES",
  "PRODUCT",
  "FUNDRAISING",
  "OPERATIONS",
  "HIRING",
  "FINANCE",
  "TECHNOLOGY",
  "LEADERSHIP",
  "INDUSTRY_KNOWLEDGE",
]);

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

  const rawPhone = fieldStr(f, MEMBER_FIELDS.phone);
  const rawPrefix = fieldStr(f, MEMBER_FIELDS.phonePrefix);
  const phoneParts = splitStoredPhone(rawPhone, rawPrefix);

  const industrySplit = splitIndustryForUi(fieldStr(f, MEMBER_FIELDS.industry));

  let helpWanted = linkIdsFromField(f[MEMBER_FIELDS.helpWanted]);
  let helpWantedContext = fieldStr(f, MEMBER_FIELDS.helpWantedContext);
  if (helpWanted.length === 0 && helpWantedContext) {
    const legacy = parseLegacyCodesFromContext(helpWantedContext, LEGACY_HELP_CODES);
    if (legacy.codes.length) {
      helpWanted = legacy.codes;
      helpWantedContext = legacy.prose;
    }
  }

  let expertiseOffered = linkIdsFromField(f[MEMBER_FIELDS.expertise]);
  let expertiseContext = fieldStr(f, MEMBER_FIELDS.expertiseContext);
  if (expertiseOffered.length === 0 && expertiseContext) {
    const legacy = parseLegacyCodesFromContext(
      expertiseContext,
      LEGACY_EXPERTISE_CODES
    );
    if (legacy.codes.length) {
      expertiseOffered = legacy.codes;
      expertiseContext = legacy.prose;
    }
  }

  return {
    airtableRecordId: record.id,
    name: fieldStr(f, MEMBER_FIELDS.name),
    firstName: fieldStr(f, MEMBER_FIELDS.firstName),
    lastName: fieldStr(f, MEMBER_FIELDS.lastName),
    email: fieldStr(f, MEMBER_FIELDS.email),
    phone: phoneParts.phone,
    phonePrefix: phoneParts.phonePrefix,
    phoneLegacyUnparsed: phoneParts.legacyUnparsed,
    postCode: fieldStr(f, MEMBER_FIELDS.postCode),
    city: fieldStr(f, MEMBER_FIELDS.city),
    cityCode: relId,
    countryCode: "",
    /** True when stored city relation is not in the current form-enabled catalogue. */
    previousCityUnavailable: false,
    previousCityLabel: fieldStr(f, MEMBER_FIELDS.city),
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
    professionalHeadline: fieldStr(f, MEMBER_FIELDS.professionalHeadline),
    profileBio: fieldStr(f, MEMBER_FIELDS.profileBio),
    socialLinks: parseSocialMediaField(f[MEMBER_FIELDS.socialMedia]),
    primaryIndustry: industrySplit.primaryIndustry,
    otherIndustry: industrySplit.otherIndustry,
    businessStage: fieldStr(f, MEMBER_FIELDS.businessStage),
    annualRevenue: fieldStr(f, MEMBER_FIELDS.revenue),
    businessDescription: fieldStr(f, MEMBER_FIELDS.businessDescription),
    ninetyDayGoal: fieldStr(f, MEMBER_FIELDS.ninetyDayGoal),
    helpWanted,
    helpWantedContext,
    expertiseOffered,
    expertiseContext,
    connectionType: fieldStr(f, MEMBER_FIELDS.connectionType),
    topicsToDiscuss: fieldStr(f, MEMBER_FIELDS.topicsToDiscuss),
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
  const { findCatalogCityByCode } = await import("@/lib/forms/reference-data");

  let cityCode = loc.cityCode || base.cityCode;
  let countryCode = loc.countryCode || base.countryCode;
  let previousCityUnavailable = false;

  if (cityCode) {
    const eligible = await findCatalogCityByCode(cityCode, airtable);
    if (!eligible) {
      // Do not inject disabled cities into the catalogue — clear selection for the form.
      previousCityUnavailable = true;
      cityCode = "";
      // Keep country if still resolvable from stored text / relation country
      if (!countryCode && loc.countryCode) countryCode = loc.countryCode;
    }
  }

  return {
    ...base,
    city: loc.city || base.city,
    cityCode,
    countryCode,
    previousCityUnavailable,
    previousCityLabel: base.previousCityLabel || loc.city || base.city,
  };
}

// Re-export for tests
export { stripComputedMemberWriteFields } from "@/lib/forms/airtable/write-guards";
