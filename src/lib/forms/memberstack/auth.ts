/**
 * Server-side Memberstack token verification.
 * Uses Admin API when MEMBERSTACK_SECRET_KEY is set.
 */
import { FormsError } from "@/lib/forms/errors";

export type VerifiedMemberstackMember = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  raw: Record<string, unknown>;
};

function getAdminKey(): string {
  return (
    process.env.MEMBERSTACK_SECRET_KEY?.trim() ||
    process.env.MEMBERSTACK_ADMIN_KEY?.trim() ||
    ""
  );
}

/**
 * Verify bearer/member token and return member identity.
 * In test/dev without MS configured, accepts X-Test-Memberstack-* headers only when
 * ALLOW_MEMBERSTACK_TEST_AUTH=true (never in production).
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

  // Memberstack Admin API — verify member token
  const res = await fetch("https://admin.memberstack.com/members/verify-token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": adminKey,
    },
    body: JSON.stringify({ token: t }),
  });

  if (!res.ok) {
    // Fallback: some MS setups use GET member by token header
    const res2 = await fetch("https://admin.memberstack.com/members/me", {
      headers: {
        Authorization: `Bearer ${t}`,
        "X-API-KEY": adminKey,
      },
    });
    if (!res2.ok) {
      throw new FormsError("MEMBERSTACK_API_FAILED", "Invalid Memberstack session", {
        status: 401,
        retryable: false,
      });
    }
    const data2 = (await res2.json()) as Record<string, unknown>;
    return mapMember(data2);
  }

  const data = (await res.json()) as Record<string, unknown>;
  return mapMember(data.data && typeof data.data === "object" ? (data.data as Record<string, unknown>) : data);
}

function mapMember(data: Record<string, unknown>): VerifiedMemberstackMember {
  const id = String(data.id || data.memberId || "").trim();
  const auth = (data.auth as Record<string, unknown>) || {};
  const custom = (data.customFields as Record<string, unknown>) || {};
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
    firstName: String(custom["first-name"] || custom.firstName || data.firstName || "").trim(),
    lastName: String(custom["last-name"] || custom.lastName || data.lastName || "").trim(),
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
  const res = await fetch(`https://admin.memberstack.com/members/${input.memberId}`, {
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
    throw new FormsError("MEMBERSTACK_API_FAILED", `Memberstack email update failed (${res.status})`, {
      status: 502,
      retryable: true,
    });
  }
}
