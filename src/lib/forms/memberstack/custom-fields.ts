/**
 * Memberstack custom-field keys for profile sync.
 * Labels in the MS dashboard are not always the API keys — configure via env.
 * Never sync account email here (account email is separate and already working).
 */
import { FormsError } from "@/lib/forms/errors";
import { recordIntegrationError } from "@/lib/forms/webhooks/store";

export type MemberstackProfileCustomFields = {
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  city?: string;
  country?: string;
  postCode?: string;
};

function envKey(name: string, fallback: string): string {
  return (process.env[name] || "").trim() || fallback;
}

/**
 * Default keys match common Memberstack slug style (kebab-case).
 * Override with MEMBERSTACK_CF_* env vars from the Memberstack dashboard.
 */
export function getMemberstackCustomFieldKeys(): {
  firstName: string;
  lastName: string;
  phoneNumber: string;
  city: string;
  country: string;
  postCode: string;
} {
  return {
    firstName: envKey("MEMBERSTACK_CF_FIRST_NAME", "first-name"),
    lastName: envKey("MEMBERSTACK_CF_LAST_NAME", "last-name"),
    phoneNumber: envKey("MEMBERSTACK_CF_PHONE", "phone-number"),
    city: envKey("MEMBERSTACK_CF_CITY", "city"),
    country: envKey("MEMBERSTACK_CF_COUNTRY", "country"),
    postCode: envKey("MEMBERSTACK_CF_POST_CODE", "post-code"),
  };
}

export function assertMemberstackCustomFieldKeysConfigured(): void {
  const keys = getMemberstackCustomFieldKeys();
  const missing = Object.entries(keys)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new FormsError(
      "MEMBERSTACK_API_FAILED",
      `Memberstack custom field keys not configured: ${missing.join(", ")}`,
      { status: 500, retryable: false }
    );
  }
}

/** Build customFields payload with only defined (non-undefined) values. */
export function buildMemberstackCustomFieldsPayload(
  fields: MemberstackProfileCustomFields
): Record<string, string> {
  assertMemberstackCustomFieldKeysConfigured();
  const keys = getMemberstackCustomFieldKeys();
  const out: Record<string, string> = {};
  if (fields.firstName != null) out[keys.firstName] = fields.firstName;
  if (fields.lastName != null) out[keys.lastName] = fields.lastName;
  if (fields.phoneNumber != null) out[keys.phoneNumber] = fields.phoneNumber;
  if (fields.city != null) out[keys.city] = fields.city;
  if (fields.country != null) out[keys.country] = fields.country;
  if (fields.postCode != null) out[keys.postCode] = fields.postCode;
  return out;
}

const ADMIN_BASE = "https://admin.memberstack.com";

function getAdminKey(): string {
  return (
    process.env.MEMBERSTACK_SECRET_KEY?.trim() ||
    process.env.MEMBERSTACK_ADMIN_KEY?.trim() ||
    ""
  );
}

/**
 * PATCH Memberstack member custom fields only (never email).
 * Idempotent: same values may be sent repeatedly.
 */
export async function syncMemberstackCustomFields(input: {
  memberId: string;
  fields: MemberstackProfileCustomFields;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const adminKey = getAdminKey();
  if (!adminKey) {
    return { ok: false, message: "MEMBERSTACK_SECRET_KEY is not configured" };
  }

  let customFields: Record<string, string>;
  try {
    customFields = buildMemberstackCustomFieldsPayload(input.fields);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Invalid custom field config";
    return { ok: false, message: msg };
  }

  if (Object.keys(customFields).length === 0) {
    return { ok: true };
  }

  try {
    const res = await fetch(
      `${ADMIN_BASE}/members/${encodeURIComponent(input.memberId)}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": adminKey,
        },
        body: JSON.stringify({ customFields }),
      }
    );
    if (!res.ok) {
      const msg = `Memberstack custom field update failed (${res.status})`;
      await recordIntegrationError({
        code: "MEMBERSTACK_API_FAILED",
        source: "memberstack_custom_fields",
        operation: "PATCH /members/:id customFields",
        title: "Memberstack custom field sync failed",
        message: msg,
        memberstackId: input.memberId,
        retryable: true,
        details: { fieldKeys: Object.keys(customFields) },
      }).catch(() => undefined);
      return { ok: false, message: msg };
    }
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Memberstack custom field sync failed";
    await recordIntegrationError({
      code: "MEMBERSTACK_API_FAILED",
      source: "memberstack_custom_fields",
      operation: "PATCH /members/:id customFields",
      title: "Memberstack custom field sync failed",
      message: msg,
      memberstackId: input.memberId,
      retryable: true,
    }).catch(() => undefined);
    return { ok: false, message: msg };
  }
}
