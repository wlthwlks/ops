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
import {
  normalizeEmailStrict,
  maskEmail,
} from "@/lib/billing/reconcile-stripe-customers";
import {
  availabilityCodesToLegacyString,
  findCatalogCityByCode,
  linkIdsFromField,
  resolveMemberLocationDto,
  splitIndustryForUi,
  splitStoredPhone,
} from "@/lib/forms/reference-data";
import { FormsError } from "@/lib/forms/errors";
import {
  isEstablishedOnboarding,
  isInProgressOnboarding,
} from "@/lib/forms/onboarding/onboarding-status";
import { canWriteAirtableFromForms } from "@/lib/forms/feature-flags";
import { stripComputedMemberWriteFields } from "@/lib/forms/airtable/write-guards";
import {
  parseSocialMediaField,
} from "@/lib/forms/validation/profile-urls";
import {
  acquireSignupCreation,
  markSignupCreationComplete,
  markSignupCreationFailed,
  waitForSignupCreation,
  BOOTSTRAP_WAIT_TIMEOUT_MS,
  BOOTSTRAP_POLL_INTERVAL_MS,
  WEBHOOK_WAIT_TIMEOUT_MS,
  WEBHOOK_POLL_INTERVAL_MS,
  type SignupCaller,
} from "@/lib/forms/airtable/signup-creation-lock";

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
  age?: string;
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

export type UpsertMinimalSignupOptions = {
  /**
   * Identifies which flow initiated the upsert. Bootstrap is the canonical
   * initial creator and is allowed to perform the Airtable create. The
   * memberstack_webhook caller is non-canonical and will defer to bootstrap
   * (returning `deferred: true`) when bootstrap is still processing, instead
   * of racing to create a duplicate Airtable row.
   */
  caller?: SignupCaller;
};

export type UpsertMinimalSignupResult = {
  record: AirtableRecord | null;
  created: boolean;
  shadowed: boolean;
  /** Webhook-only: bootstrap still owns the creation lock; do not create. */
  deferred?: boolean;
};

/**
 * Build the write payload for a minimal signup member. Pure — no I/O.
 * Shared between bootstrap and webhook paths so the field set is identical.
 */
function buildMinimalSignupFields(
  input: MinimalSignupInput,
  email: string,
  existing: AirtableRecord | null
): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    [MEMBER_FIELDS.email]: email,
    [MEMBER_FIELDS.memberstackId]: input.memberstackId,
    [MEMBER_FIELDS.firstName]: input.firstName,
    [MEMBER_FIELDS.lastName]: input.lastName,
    ...(input.age ? { [MEMBER_FIELDS.age]: input.age } : {}),
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
  return fields;
}

async function writeMinimalSignup(
  input: MinimalSignupInput,
  email: string,
  existing: AirtableRecord | null,
  airtable: AirtableClient
): Promise<{ record: AirtableRecord; created: boolean; shadowed: boolean }> {
  const fields = buildMinimalSignupFields(input, email, existing);

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

/**
 * Resolve an existing Airtable Member for this signup, surfacing identity
 * conflicts and duplicate rows consistently for both bootstrap and webhook.
 *
 * Returns one of:
 *   - {kind:"found", record}     — exactly one match (by ms id OR email) that
 *                                  is safe to update.
 *   - {kind:"none"}              — no rows matched either identity.
 *   - {kind:"duplicate"}         — multiple rows matched an identity; the
 *                                  caller MUST NOT create or arbitrarily
 *                                  update. Existing `requireUnique` behaviour.
 *   - {kind:"identity_conflict"} — a record matched on email but owns a
 *                                  *different* non-empty Memberstack ID.
 *                                  Caller must surface MEMBER_IDENTITY_CONFLICT.
 */
async function resolveExistingAirtableForSignup(
  input: MinimalSignupInput,
  email: string,
  airtable: AirtableClient
): Promise<
  | { kind: "found"; record: AirtableRecord }
  | { kind: "none" }
  | { kind: "duplicate"; ids: string[] }
  | {
      kind: "identity_conflict";
      recordId: string;
      currentMemberstackId: string;
      incomingMemberstackId: string;
    }
> {
  const byMs = await findMemberByMemberstackId(input.memberstackId, airtable);
  if (byMs.length > 1) {
    return { kind: "duplicate", ids: byMs.map((r) => r.id) };
  }
  if (byMs.length === 1) {
    return { kind: "found", record: byMs[0] };
  }

  // No match by Memberstack ID — try email recovery. This is the "blank
  // Memberstack ID" recovery path. A record with the same email but a
  // *different non-empty* Memberstack ID is an identity conflict, NOT a
  // recovery opportunity.
  const byEmail = await findMemberByNormalizedEmailForSignupRecovery(email, airtable);
  if (byEmail.length > 1) {
    return { kind: "duplicate", ids: byEmail.map((r) => r.id) };
  }
  if (byEmail.length === 1) {
    const existingMsId = fieldStr(byEmail[0].fields, MEMBER_FIELDS.memberstackId);
    if (existingMsId && existingMsId !== input.memberstackId.trim()) {
      return {
        kind: "identity_conflict",
        recordId: byEmail[0].id,
        currentMemberstackId: existingMsId,
        incomingMemberstackId: input.memberstackId,
      };
    }
    return { kind: "found", record: byEmail[0] };
  }
  return { kind: "none" };
}

export async function upsertMinimalSignupMember(
  input: MinimalSignupInput,
  airtable: AirtableClient = getFormsAirtableClient(),
  options?: UpsertMinimalSignupOptions
): Promise<UpsertMinimalSignupResult> {
  return upsertMinimalSignupMemberImpl(input, airtable, options, 0);
}

async function upsertMinimalSignupMemberImpl(
  input: MinimalSignupInput,
  airtable: AirtableClient,
  options: UpsertMinimalSignupOptions | undefined,
  attempt: number
): Promise<UpsertMinimalSignupResult> {
  if (attempt > 2) {
    throw new FormsError(
      "SIGNUP_CREATION_FAILED",
      "Signup creation exceeded retry attempts while waiting for a concurrent creator",
      { status: 503, retryable: true }
    );
  }
  const caller: SignupCaller = options?.caller ?? "bootstrap";
  const email = normalizeEmailStrict(input.email);

  // Step 1: existing record / conflict resolution — happens BEFORE the lock
  // so already-enrolled members never touch the mutex and existing duplicate
  // detection is preserved.
  const existing = await resolveExistingAirtableForSignup(input, email, airtable);
  if (existing.kind === "duplicate") {
    throw new FormsError(
      "AIRTABLE_DUPLICATE_MEMBER",
      "Duplicate Airtable members for Memberstack ID or email",
      { status: 409, details: { ids: existing.ids } }
    );
  }
  if (existing.kind === "identity_conflict") {
    throw conflictError(input, email, existing);
  }
  if (existing.kind === "found") {
    // Update + reconcile existing record. No new row is created; no lock needed.
    return await writeMinimalSignup(input, email, existing.record, airtable);
  }

  // Step 2: no existing Airtable record. Acquire the per-member creation lock.
  const lock = await acquireSignupCreation({
    memberstackId: input.memberstackId,
    email,
    source: caller,
  });

  if (lock.kind === "unavailable") {
    // DB not reachable — degrade to legacy direct Airtable create. Same
    // behaviour as before this module existed. Acceptable because Airtable
    // duplicates are an edge case (Svix redelivery + bootstrap racing)
    // and we never want to hard-block signup on a missing DB.
    return await writeMinimalSignup(input, email, null, airtable);
  }

  if (lock.kind === "already_created") {
    // Another caller *claimed* to finish the initial create. Re-resolve
    // Airtable and reconcile. If the record has vanished (manual delete),
    // delete the stale lock row and retry once so we become the creator.
    const resolved = await resolveExistingAirtableForSignup(input, email, airtable);
    if (resolved.kind === "found") {
      return await writeMinimalSignup(input, email, resolved.record, airtable);
    }
    if (resolved.kind === "duplicate") {
      throw new FormsError(
        "AIRTABLE_DUPLICATE_MEMBER",
        "Duplicate Airtable members for Memberstack ID or email",
        { status: 409, details: { ids: resolved.ids } }
      );
    }
    if (resolved.kind === "identity_conflict") {
      throw conflictError(input, email, resolved);
    }
    // resolved.kind === "none" — lock said CREATED but Airtable is empty.
    // This is an inconsistent state; delete the lock row so the next
    // attempt can re-acquire from scratch. We bound the retry count to
    // prevent infinite loops if the inconsistency persists.
    await deleteSignupCreationLockRow(input.memberstackId);
    return upsertMinimalSignupMemberImpl(input, airtable, options, attempt + 1);
  }

  if (lock.kind === "acquired") {
    return await createAsOwner(input, email, airtable);
  }

  // lock.kind === "pending" — another caller owns the CREATING row.
  const timeoutMs =
    caller === "bootstrap" ? BOOTSTRAP_WAIT_TIMEOUT_MS : WEBHOOK_WAIT_TIMEOUT_MS;
  const pollMs =
    caller === "bootstrap"
      ? BOOTSTRAP_POLL_INTERVAL_MS
      : WEBHOOK_POLL_INTERVAL_MS;

  const airtableRecordId = await waitForSignupCreation({
    memberstackId: input.memberstackId,
    timeoutMs,
    pollIntervalMs: pollMs,
  });

  if (airtableRecordId) {
    // The winning creator finished while we waited. Re-resolve Airtable and
    // reconcile. Under Svix redelivery this is the idempotent success path.
    const resolved = await resolveExistingAirtableForSignup(input, email, airtable);
    if (resolved.kind === "found") {
      return await writeMinimalSignup(input, email, resolved.record, airtable);
    }
    if (resolved.kind === "duplicate") {
      throw new FormsError(
        "AIRTABLE_DUPLICATE_MEMBER",
        "Duplicate Airtable members for Memberstack ID or email",
        { status: 409, details: { ids: resolved.ids } }
      );
    }
    if (resolved.kind === "identity_conflict") {
      throw conflictError(input, email, resolved);
    }
    // Lock said CREATED but Airtable has no record — delete + retry.
    await deleteSignupCreationLockRow(input.memberstackId);
    return upsertMinimalSignupMemberImpl(input, airtable, options, attempt + 1);
  }

  // Timed out waiting for the canonical creator.
  if (caller === "bootstrap") {
    // Bootstrap is synchronous and the user is waiting. Re-attempt acquire;
    // `acquireSignupCreation` will steal a *stale* (>= 120s) lock if the
    // competitor has crashed, otherwise we surface a retryable 503 so the
    // user can re-submit (the webhook or a retry will eventually create the
    // record). We NEVER call Airtable create from the loser path — this is
    // the core guarantee against duplicate rows.
    const retry = await acquireSignupCreation({
      memberstackId: input.memberstackId,
      email,
      source: caller,
    });
    if (retry.kind === "acquired") {
      return await createAsOwner(input, email, airtable);
    }
    if (retry.kind === "already_created") {
      // Caller finished just after our poll timed out.
      const resolved = await resolveExistingAirtableForSignup(input, email, airtable);
      if (resolved.kind === "found") {
        return await writeMinimalSignup(input, email, resolved.record, airtable);
      }
    }
    throw new FormsError(
      "SIGNUP_CREATION_IN_PROGRESS",
      "Signup creation is still in progress by another request — please retry",
      { status: 503, retryable: true }
    );
  }

  // caller === "memberstack_webhook"
  // Defer — do NOT race-create. The webhook layer surfaces this as
  // pending_dependency so Memberstack / Svix redelivery (or bootstrap in
  // the next milliseconds) reconciles. This is the key guarantee: two
  // concurrent requests for the same Memberstack member can never produce
  // two Airtable rows.
  return {
    record: null,
    created: false,
    shadowed: false,
    deferred: true,
  };
}

async function createAsOwner(
  input: MinimalSignupInput,
  email: string,
  airtable: AirtableClient
): Promise<UpsertMinimalSignupResult> {
  // Re-check Airtable one more time inside the lock — covers the tiny
  // window between Step 1's read and Step 2's INSERT for callers that lost
  // the lock to a creator who has since finished.
  const recheck = await resolveExistingAirtableForSignup(input, email, airtable);
  if (recheck.kind === "found") {
    await markSignupCreationComplete({
      memberstackId: input.memberstackId,
      airtableRecordId: recheck.record.id,
    });
    return await writeMinimalSignup(input, email, recheck.record, airtable);
  }
  if (recheck.kind === "duplicate") {
    await markSignupCreationFailed({
      memberstackId: input.memberstackId,
      reason: "AIRTABLE_DUPLICATE_MEMBER",
    });
    throw new FormsError(
      "AIRTABLE_DUPLICATE_MEMBER",
      "Duplicate Airtable members for Memberstack ID or email",
      { status: 409, details: { ids: recheck.ids } }
    );
  }
  if (recheck.kind === "identity_conflict") {
    await markSignupCreationFailed({
      memberstackId: input.memberstackId,
      reason: "MEMBER_IDENTITY_CONFLICT",
    });
    throw conflictError(input, email, recheck);
  }

  // recheck.kind === "none": we are the sole creator. Create now.
  try {
    const created = await writeMinimalSignup(input, email, null, airtable);
    if (created.record?.id && created.record.id !== "shadow") {
      await markSignupCreationComplete({
        memberstackId: input.memberstackId,
        airtableRecordId: created.record.id,
      });
    } else if (created.shadowed) {
      await markSignupCreationComplete({
        memberstackId: input.memberstackId,
        airtableRecordId: created.record?.id ?? "shadow",
      });
    }
    return created;
  } catch (e) {
    await markSignupCreationFailed({
      memberstackId: input.memberstackId,
      reason: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }
}

function conflictError(
  input: MinimalSignupInput,
  email: string,
  c: {
    kind: "identity_conflict";
    recordId: string;
    currentMemberstackId: string;
    incomingMemberstackId: string;
  }
): FormsError {
  return new FormsError(
    "MEMBER_IDENTITY_CONFLICT",
    "Email matches a member already owned by a different Memberstack ID",
    {
      status: 409,
      retryable: false,
      details: {
        airtableRecordId: c.recordId,
        currentMemberstackIdPrefix: c.currentMemberstackId.slice(0, 6),
        incomingMemberstackIdPrefix: c.incomingMemberstackId.slice(0, 6),
        emailMasked: maskEmail(email),
      },
    }
  );
}

/**
 * Internal helper: hard-deletes a lock row so the next attempt can re-acquire
 * via fresh INSERT. Used ONLY to recover from inconsistent states where the
 * lock said CREATED but Airtable has no record, or after a bootstrap wait
 * timeout to give a stuck lock a clean slate. Cannot lose a real Airtable
 * record — the caller already re-verified Airtable is empty.
 */
async function deleteSignupCreationLockRow(memberstackId: string): Promise<void> {
  try {
    const { db } = await import("@/db");
    const { signupMemberCreations } = await import(
      "@/db/schema/signup-member-creations"
    );
    const { eq } = await import("drizzle-orm");
    await db
      .delete(signupMemberCreations)
      .where(eq(signupMemberCreations.memberstackId, memberstackId.trim()));
  } catch {
    /* DB unavailable — degrade gracefully */
  }
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

  // "Onboarding status" is lifecycle-only: it must never regress an established
  // member (blank legacy or COMPLETE) back into a signup stage — e.g. the
  // matching GOAL / HELP_WANTED / EXPERTISE / CONNECTION steps. The update-details
  // refresh flow must not silently reset an established member's onboarding status.
  const currentOnboardingStatus = String(
    existing.fields[MEMBER_FIELDS.onboardingStatus] ?? ""
  ).trim();
  const incomingStage = String(input.stage || "").trim().toUpperCase();
  if (
    incomingStage !== "COMPLETE" &&
    incomingStage !== "COMPLETED" &&
    isEstablishedOnboarding(currentOnboardingStatus)
  ) {
    return { record: existing, shadowed: false };
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
  const billingFields = [
    "Membership",
    "Payment",
    "Service access until",
    "Stripe Price ID",
    "Stripe Subscription ID",
    "Stripe subscription status",
    "Cancel at period end",
    "Cancellation effective at",
    "Memberstack Plan ID",
  ];
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of billingFields) {
    if (Object.prototype.hasOwnProperty.call(input.patch, f)) {
      const to = input.patch[f];
      if (String(existing.fields[f] ?? "") !== String(to ?? "")) {
        changed[f] = { from: existing.fields[f] ?? null, to: to ?? null };
      }
    }
  }
  if (Object.keys(changed).length > 0) {
    console.error(
      JSON.stringify({
        event: "billing_write",
        source: "update_member_billing",
        stripeCustomerId: input.stripeCustomerId,
        airtableRecordId: existing.id,
        changed,
      })
    );
  }
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
  // Only advance onboarding for genuinely in-progress signups. Established
  // members (blank legacy or COMPLETE) must never be reset into the signup form.
  if (isInProgressOnboarding(currentStatus)) {
    patch[MEMBER_FIELDS.onboardingStatus] = "PAYMENT_CONFIRMED";
  }

  const billingFields = [
    "Membership",
    "Payment",
    "Service access until",
    "Stripe Price ID",
    "Stripe Subscription ID",
    "Stripe subscription status",
    "Cancel at period end",
    "Cancellation effective at",
    "Memberstack Plan ID",
  ];
  const changed: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of billingFields) {
    if (Object.prototype.hasOwnProperty.call(patch, f)) {
      const to = patch[f];
      if (String(existing.fields[f] ?? "") !== String(to ?? "")) {
        changed[f] = { from: existing.fields[f] ?? null, to: to ?? null };
      }
    }
  }
  if (Object.keys(changed).length > 0) {
    console.error(
      JSON.stringify({
        event: "billing_write",
        source: "apply_trusted_payment",
        memberstackId: msId,
        stripeCustomerId: cus,
        airtableRecordId: existing.id,
        changed,
      })
    );
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
    age: fieldStr(f, MEMBER_FIELDS.age),
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
