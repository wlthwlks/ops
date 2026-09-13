/**
 * SweatPals external API client (server-only).
 *
 * SweatPals is the source of truth for membership state. The external API is
 * lookup-only (it never creates users) and scoped to our community by the API
 * key itself (x-api-key header). Reference: SweatPals Public API Postman docs.
 *
 * Endpoints used:
 *   - GET  {base}/api/external/communities              (communityId resolution)
 *   - POST {base}/api/external/members/memberships      (member membership lookup)
 *   - GET  {base}/api/zapier-provider/{new-members|cancelled-members|renewed-members}
 *                                                       (pollable lifecycle feeds)
 *
 * Environment:
 *   SWEATPALS_API_KEY          (required)  key from SweatPals dashboard
 *                                          (Integrations → Data & Automations → Zapier).
 *                                          Staging keys do not work against production.
 *   SWEATPALS_COMMUNITY_ID     (optional)  override — otherwise auto-resolved from
 *                                          GET /api/external/communities.
 *   SWEATPALS_API_BASE         (optional)  default https://ilove.sweatpals.com
 *                                          (https://ilove.staging.sweatpals.com per env).
 *                                          A trailing "/api" is tolerated and stripped.
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

export type SweatpalsCommunity = {
  id: string;
  userName: string;
  fullName?: string;
  login?: string | null;
  [key: string]: unknown;
};

/** One row from a zapier-provider lifecycle feed (fields vary per feed). */
export type SweatpalsFeedRow = {
  id: string;
  community_id?: string;
  community_name?: string;
  membership_name?: string;
  membership_id?: string;
  membershipTier_amount?: number;
  user_id?: string;
  user_phone?: string;
  user_email?: string;
  user_fullName?: string;
  createdAt?: string;
  updatedAt?: string;
  renewedAt?: string;
  renewalType?: string;
  [key: string]: unknown;
};

export type SweatpalsFeedName = "new-members" | "cancelled-members" | "renewed-members";

export type SweatpalsApiConfig = {
  apiBase: string;
  apiKey: string;
  /** Optional env override — otherwise resolved via /external/communities. */
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

function normalizeApiBase(raw: string): string {
  return raw
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/api$/i, "");
}

/** Lazy env read so Next.js build never requires keys at module load. */
export function getSweatpalsApiConfig(): SweatpalsApiConfig {
  const apiKey = (process.env.SWEATPALS_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("SWEATPALS_API_KEY is not set");
  }
  return {
    apiBase: normalizeApiBase(process.env.SWEATPALS_API_BASE || "https://ilove.sweatpals.com"),
    apiKey,
    communityId: (process.env.SWEATPALS_COMMUNITY_ID || "").trim(),
    apiKeyHeader: (process.env.SWEATPALS_API_KEY_HEADER || "x-api-key").trim(),
    timeoutMs: Number(process.env.SWEATPALS_API_TIMEOUT_MS || "10000"),
  };
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
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

function apiHeaders(cfg: SweatpalsApiConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  headers[cfg.apiKeyHeader] = cfg.apiKey;
  return headers;
}

function messageFromBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== "object") return fallback;
  const b = body as Record<string, unknown>;
  const msg = b.message;
  if (typeof msg === "string" && msg) return msg;
  if (Array.isArray(msg) && msg.length > 0) return String(msg[0]);
  return fallback;
}

/** All communities in the API-key scope (a community key returns just ours). */
export async function listCommunities(): Promise<SweatpalsCommunity[]> {
  const cfg = getSweatpalsApiConfig();
  const url = `${cfg.apiBase}/api/external/communities`;
  const { status, body } = await getJson(url, apiHeaders(cfg), cfg.timeoutMs);
  if (status >= 200 && status < 300 && Array.isArray(body)) {
    return body as SweatpalsCommunity[];
  }
  if (status === 401 || status === 403) {
    throw new SweatpalsApiError(
      `SweatPals API key is not authorized (HTTP ${status})`,
      status
    );
  }
  throw new SweatpalsApiError(
    messageFromBody(body, `SweatPals communities failed (HTTP ${status})`),
    status
  );
}

let _communityIdCache: { value: string; expiresAt: number } | null = null;

/**
 * Community UUID for the API key's scope. Uses SWEATPALS_COMMUNITY_ID when set;
 * otherwise resolves from GET /api/external/communities and caches (~1h).
 */
export async function resolveCommunityId(): Promise<string> {
  const cfg = getSweatpalsApiConfig();
  if (cfg.communityId) return cfg.communityId;

  const now = Date.now();
  if (_communityIdCache && _communityIdCache.expiresAt > now) {
    return _communityIdCache.value;
  }

  const communities = await listCommunities();
  if (communities.length === 0) {
    throw new SweatpalsApiError(
      "SweatPals returned no communities for this API key",
      404
    );
  }
  if (communities.length > 1) {
    throw new SweatpalsApiError(
      "SweatPals API key spans multiple communities — set SWEATPALS_COMMUNITY_ID to disambiguate",
      409
    );
  }
  const id = String(communities[0].id || "").trim();
  if (!id) {
    throw new SweatpalsApiError("SweatPals community response missing id", 502);
  }
  _communityIdCache = { value: id, expiresAt: now + 60 * 60 * 1000 };
  return id;
}

/** Reset the cached community id (tests / config changes). */
export function resetCommunityIdCache(): void {
  _communityIdCache = null;
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
  const communityId = await resolveCommunityId();

  const url = `${cfg.apiBase}/api/external/members/memberships`;
  const payload: Record<string, unknown> = {
    communityId,
    page: opts.page ?? 1,
    pageSize: opts.pageSize ?? 25,
  };
  if (opts.email) payload.email = opts.email.trim();
  if (opts.phone) payload.phone = opts.phone.trim();

  const attempts = 3;
  for (let i = 0; i < attempts; i++) {
    try {
      const { status, body } = await postJson(url, apiHeaders(cfg), payload, cfg.timeoutMs);
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
      throw new SweatpalsApiError(
        messageFromBody(body, `SweatPals memberships lookup failed (HTTP ${status})`),
        status
      );
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

/**
 * Pollable lifecycle feed (most-recent-first, paginated). Row shape varies per
 * feed — see SweatpalsFeedRow. Empty array when there are no rows.
 */
export async function getZapierFeed(
  feed: SweatpalsFeedName,
  opts: { page?: number; pageSize?: number } = {}
): Promise<SweatpalsFeedRow[]> {
  const cfg = getSweatpalsApiConfig();
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 100;
  const url = `${cfg.apiBase}/api/zapier-provider/${feed}?pageSize=${pageSize}&page=${page}`;

  const { status, body } = await getJson(url, apiHeaders(cfg), cfg.timeoutMs);
  if (status >= 200 && status < 300 && Array.isArray(body)) {
    return body as SweatpalsFeedRow[];
  }
  if (status === 401 || status === 403) {
    throw new SweatpalsApiError(
      `SweatPals API key is not authorized (HTTP ${status})`,
      status
    );
  }
  throw new SweatpalsApiError(
    messageFromBody(body, `SweatPals ${feed} feed failed (HTTP ${status})`),
    status
  );
}
