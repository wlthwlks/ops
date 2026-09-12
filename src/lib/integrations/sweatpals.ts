/**
 * SweatPals external API client (server-only).
 *
 * SweatPals is the source of truth for membership state. The external API is
 * lookup-only (it never creates users) and scoped to our community via an API
 * key. It returns a paginated list of memberships for a member identified by
 * phone or email.
 *
 * Docs: POST {base}/api/external/members/memberships
 *   - 201: paginated { list, limit, offset, total }
 *   - 404: community outside API key scope, or member unresolved / not a
 *          customer of the community.
 *
 * Environment:
 *   SWEATPALS_API_KEY          (required)  key from SweatPals
 *   SWEATPALS_COMMUNITY_ID     (required)  our community UUID
 *   SWEATPALS_API_BASE         (optional)  default https://ilove.sweatpals.com
 *                                          (use https://ilove.staging.sweatpals.com /
 *                                          https://ilove.dev.sweatpals.com per env)
 *   SWEATPALS_API_KEY_HEADER   (optional)  default x-api-key
 *   SWEATPALS_API_TIMEOUT_MS   (optional)  default 10000
 */

export type SweatpalsMembershipItem = {
  membershipName: string;
  /** SweatPals membership item id (the userToMembershipId used by /fix-billing/{id}). */
  id: string;
  membershipId: string;
  membershipTierId: string;
  active: boolean;
  paused: boolean;
  pauseFuturePayments: boolean;
  actualFrom: string | null;
  actualTo: string | null;
  expireDate: string | null;
  isClaimed: boolean;
  cancellationEffectiveAt?: string | null;
};

export type SweatpalsMembershipsPage = {
  list: SweatpalsMembershipItem[];
  limit: number;
  offset: number;
  total: number;
};

export type SweatpalsLookupOptions = {
  email?: string;
  phone?: string;
  page?: number;
  pageSize?: number;
};

export type SweatpalsApiConfig = {
  apiBase: string;
  apiKey: string;
  communityId: string;
  apiKeyHeader: string;
  timeoutMs: number;
};

export class SweatpalsApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SweatpalsApiError";
    this.status = status;
  }
}

/** Lazy env read so Next.js build never requires keys at module load. */
export function getSweatpalsApiConfig(): SweatpalsApiConfig {
  const apiKey = (process.env.SWEATPALS_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("SWEATPALS_API_KEY is not set");
  }
  const communityId = (process.env.SWEATPALS_COMMUNITY_ID || "").trim();
  if (!communityId) {
    throw new Error("SWEATPALS_COMMUNITY_ID is not set");
  }
  return {
    apiBase: (process.env.SWEATPALS_API_BASE || "https://ilove.sweatpals.com")
      .trim()
      .replace(/\/+$/, ""),
    apiKey,
    communityId,
    apiKeyHeader: (process.env.SWEATPALS_API_KEY_HEADER || "x-api-key").trim(),
    timeoutMs: Number(process.env.SWEATPALS_API_TIMEOUT_MS || "10000"),
  };
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs: number
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

/**
 * Look up a member's memberships scoped to our community.
 * Returns null when SweatPals responds 404 (member unresolved / not a customer).
 * Throws SweatpalsApiError on auth/config failures.
 */
export async function getMemberMemberships(
  opts: SweatpalsLookupOptions
): Promise<SweatpalsMembershipsPage | null> {
  if (!opts.email && !opts.phone) {
    throw new Error("SweatPals lookup requires email or phone");
  }
  const cfg = getSweatpalsApiConfig();

  const url = `${cfg.apiBase}/api/external/members/memberships`;
  const headers: Record<string, string> = {};
  headers[cfg.apiKeyHeader] = cfg.apiKey;

  const payload: Record<string, unknown> = {
    communityId: cfg.communityId,
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? 25,
  };
  if (opts.email) payload.email = opts.email.trim();
  if (opts.phone) payload.phone = opts.phone.trim();

  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      const { status, body } = await postJson(url, headers, payload, cfg.timeoutMs);
      if (status === 404) return null;
      if (status >= 200 && status < 300 && body && typeof body === "object") {
        return body as SweatpalsMembershipsPage;
      }
      if (status === 401 || status === 403) {
        throw new SweatpalsApiError(
          `SweatPals API key is not authorized (HTTP ${status})`,
          status
        );
      }
      if (status >= 500 && i < attempts - 1) continue;
      const message =
        body && typeof body === "object" && "message" in body
          ? String((body as { message: unknown }).message)
          : `SweatPals memberships lookup failed (HTTP ${status})`;
      throw new SweatpalsApiError(message, status);
    } catch (e) {
      if (e instanceof SweatpalsApiError) throw e;
      if (i < attempts - 1) continue;
      throw new SweatpalsApiError(
        `SweatPals memberships lookup failed: ${
          e instanceof Error ? e.message : String(e)
        }`,
        0
      );
    }
  }
  return null;
}
