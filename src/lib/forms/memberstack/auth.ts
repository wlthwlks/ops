/**
 * Server-side Memberstack token verification via Admin REST API.
 * Docs: POST https://admin.memberstack.com/members/verify-token
 * Returns JWT claims { id, type, iat, exp, aud, iss } under data.
 * Full member profile loaded via GET /members/:id when email is needed.
 */
import { FormsError } from "@/lib/forms/errors";

export type VerifiedMemberstackMember = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  raw: Record<string, unknown>;
};

const ADMIN_BASE = "https://admin.memberstack.com";

function getAdminKey(): string {
  return (
    process.env.MEMBERSTACK_SECRET_KEY?.trim() ||
    process.env.MEMBERSTACK_ADMIN_KEY?.trim() ||
    ""
  );
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Verify bearer/member token and return member identity.
 * Test headers only when ALLOW_MEMBERSTACK_TEST_AUTH=true outside production.
 */
export async function verifyMemberstackToken(
  token: string | null | undefined,
  request?: Request
): Promise<VerifiedMemberstackMember> {
  const t = (token || "").trim();
  const adminKey = getAdminKey();

  if (
    process.env.NODE_ENV !== "production" &&
    process.env.ALLOW_MEMBERSTACK_TEST_AUTH === "true" &&
    request
  ) {
    const testId = request.headers.get("x-test-memberstack-id");
    const testEmail = request.headers.get("x-test-memberstack-email");
    if (testId && testEmail) {
      return {
        id: testId,
        email: testEmail.toLowerCase(),
        firstName: request.headers.get("x-test-memberstack-first-name") || "",
        lastName: request.headers.get("x-test-memberstack-last-name") || "",
        raw: { test: true },
      };
    }
  }

  if (!t) {
    throw new FormsError("MEMBERSTACK_API_FAILED", "Missing Memberstack token", {
      status: 401,
    });
  }

  if (!adminKey) {
    throw new FormsError(
      "MEMBERSTACK_API_FAILED",
      "MEMBERSTACK_SECRET_KEY is not configured",
      { status: 500 }
    );
  }

  // Official Admin REST: POST /members/verify-token
  // Non-200 (typically 400 INVALID_TOKEN) ⇒ unauthenticated
  let verifyJson: unknown;
  try {
    const res = await fetch(`${ADMIN_BASE}/members/verify-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": adminKey,
      },
      body: JSON.stringify({ token: t }),
    });
    verifyJson = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new FormsError("MEMBERSTACK_API_FAILED", "Invalid Memberstack session", {
        status: 401,
        retryable: false,
      });
    }
  } catch (err) {
    if (err instanceof FormsError) throw err;
    throw new FormsError("MEMBERSTACK_API_FAILED", "Memberstack verification failed", {
      status: 502,
      retryable: true,
    });
  }

  const claimsRaw = isRecord(verifyJson) && isRecord(verifyJson.data)
    ? verifyJson.data
    : isRecord(verifyJson)
      ? verifyJson
      : null;

  const memberId = claimsRaw && typeof claimsRaw.id === "string" ? claimsRaw.id.trim() : "";
  if (!memberId) {
    throw new FormsError("MEMBERSTACK_API_FAILED", "Invalid Memberstack session", {
      status: 401,
    });
  }

  // Optional exp check
  if (claimsRaw && typeof claimsRaw.exp === "number") {
    const now = Math.floor(Date.now() / 1000);
    if (claimsRaw.exp < now) {
      throw new FormsError("MEMBERSTACK_API_FAILED", "Memberstack session expired", {
        status: 401,
      });
    }
  }

  // Load member profile for email / name (verify-token returns JWT claims only)
  try {
    const memberRes = await fetch(
      `${ADMIN_BASE}/members/${encodeURIComponent(memberId)}`,
      {
        headers: { "X-API-KEY": adminKey },
      }
    );
    const memberJson = (await memberRes.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!memberRes.ok) {
      // Token valid but profile fetch failed — still allow with id only if email in claims
      const claimEmail =
        claimsRaw && typeof claimsRaw.email === "string" ? claimsRaw.email : "";
      if (claimEmail) {
        return {
          id: memberId,
          email: claimEmail.toLowerCase(),
          firstName: "",
          lastName: "",
          raw: claimsRaw || { id: memberId },
        };
      }
      throw new FormsError("MEMBERSTACK_API_FAILED", "Could not load Memberstack member", {
        status: 502,
        retryable: true,
      });
    }

    // GET /members/:id returns { data: member | null }
    const memberData =
      isRecord(memberJson.data) ? memberJson.data : isRecord(memberJson) ? memberJson : null;

    if (!memberData) {
      throw new FormsError("MEMBERSTACK_MEMBER_NOT_FOUND", "Memberstack member not found", {
        status: 401,
      });
    }

    return mapMember(memberData, memberId);
  } catch (err) {
    if (err instanceof FormsError) throw err;
    throw new FormsError("MEMBERSTACK_API_FAILED", "Could not load Memberstack member", {
      status: 502,
      retryable: true,
    });
  }
}

function mapMember(
  data: Record<string, unknown>,
  fallbackId?: string
): VerifiedMemberstackMember {
  const id = String(data.id || fallbackId || "").trim();
  const auth = isRecord(data.auth) ? data.auth : {};
  const custom = isRecord(data.customFields)
    ? data.customFields
    : isRecord(data.custom_fields)
      ? data.custom_fields
      : {};
  const email = String(data.email || auth.email || "")
    .trim()
    .toLowerCase();
  if (!id || !email) {
    throw new FormsError("MEMBERSTACK_API_FAILED", "Memberstack member missing id/email", {
      status: 401,
    });
  }
  return {
    id,
    email,
    firstName: String(
      custom["first-name"] || custom.firstName || custom.first_name || data.firstName || ""
    ).trim(),
    lastName: String(
      custom["last-name"] || custom.lastName || custom.last_name || data.lastName || ""
    ).trim(),
    raw: data,
  };
}

export function extractMemberstackToken(request: Request): string | null {
  const h =
    request.headers.get("x-memberstack-token") ||
    request.headers.get("authorization");
  if (!h) return null;
  if (h.toLowerCase().startsWith("bearer ")) return h.slice(7).trim();
  return h.trim();
}

export async function updateMemberstackEmail(input: {
  memberId: string;
  newEmail: string;
}): Promise<void> {
  const adminKey = getAdminKey();
  if (!adminKey) {
    throw new FormsError("MEMBERSTACK_API_FAILED", "MEMBERSTACK_SECRET_KEY missing", {
      status: 500,
    });
  }
  const res = await fetch(`${ADMIN_BASE}/members/${encodeURIComponent(input.memberId)}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": adminKey,
    },
    body: JSON.stringify({ email: input.newEmail.toLowerCase() }),
  });
  if (res.status === 409) {
    throw new FormsError("MEMBERSTACK_EMAIL_CONFLICT", "Email already in use on Memberstack", {
      status: 409,
    });
  }
  if (!res.ok) {
    throw new FormsError(
      "MEMBERSTACK_API_FAILED",
      `Memberstack email update failed (${res.status})`,
      { status: 502, retryable: true }
    );
  }
}
