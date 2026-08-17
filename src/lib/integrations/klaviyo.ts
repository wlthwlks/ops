/**
 * Minimal Klaviyo REST client for the membership-list sync cron.
 *
 * Endpoints used (JSON:API, private API key):
 *   - POST /api/profile-import/                        bulk profile upsert (10k/request)
 *   - POST /api/profile-subscription-bulk-create-jobs/ bulk subscribe (1000/job)
 *   - POST /api/profile-subscription-bulk-delete-jobs/ bulk unsubscribe (1000/job)
 *
 * Bulk jobs are async (202) — the cron fires jobs and reports counts; Klaviyo
 * finishes the list membership moves within minutes.
 */

export interface KlaviyoConfig {
  /** Klaviyo private API key (pk_…). */
  apiKey: string;
  /** JSON:API revision. Defaults to a recent stable revision. */
  revision?: string;
  /** Base URL override (tests). */
  baseUrl?: string;
  /** Max retries on 429 / 5xx (default 3). */
  maxRetries?: number;
}

export interface KlaviyoProfileInput {
  email: string;
  firstName?: string;
  lastName?: string;
  phoneNumber?: string;
  city?: string;
  zip?: string;
  country?: string;
  properties?: Record<string, string>;
}

export class KlaviyoApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, statusText: string, body: string) {
    super(`Klaviyo API error: ${status} ${statusText} — ${body.slice(0, 500)}`);
    this.name = "KlaviyoApiError";
    this.status = status;
    this.body = body;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PROFILE_IMPORT_CHUNK = 5000;
const BULK_SUBSCRIPTION_CHUNK = 1000;

export function createKlaviyoClient(config: KlaviyoConfig) {
  const baseUrl = config.baseUrl ?? "https://a.klaviyo.com/api";
  const revision = config.revision ?? "2025-04-15";
  const maxRetries = config.maxRetries ?? 3;

  async function request(
    method: "POST",
    path: string,
    body: unknown,
    attempt = 0
  ): Promise<void> {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${baseUrl}${path}${separator}revision=${encodeURIComponent(revision)}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Klaviyo-API-Key ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "", 10);
      const delay = Math.min(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * Math.pow(2, attempt),
        60_000
      );
      await sleep(delay);
      return request(method, path, body, attempt + 1);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new KlaviyoApiError(res.status, res.statusText, text);
    }
    await res.text().catch(() => "");
  }

  function buildImportProfile(p: KlaviyoProfileInput): Record<string, unknown> {
    const profile: Record<string, unknown> = { email: p.email };
    if (p.firstName) profile["first_name"] = p.firstName;
    if (p.lastName) profile["last_name"] = p.lastName;
    if (p.phoneNumber) profile["phone_number"] = p.phoneNumber;
    const location: Record<string, string> = {};
    if (p.city) location["city"] = p.city;
    if (p.zip) location["zip"] = p.zip;
    if (p.country) location["country"] = p.country;
    if (Object.keys(location).length > 0) profile["location"] = location;
    if (p.properties && Object.keys(p.properties).length > 0) {
      profile["properties"] = p.properties;
    }
    return profile;
  }

  /** Bulk upsert profiles (email + standard fields + custom properties). */
  async function profileImport(
    profiles: KlaviyoProfileInput[]
  ): Promise<{ requested: number; jobs: number }> {
    let jobs = 0;
    for (let i = 0; i < profiles.length; i += PROFILE_IMPORT_CHUNK) {
      const chunk = profiles.slice(i, i + PROFILE_IMPORT_CHUNK);
      await request("POST", "/profile-import/", {
        data: {
          type: "profile-import",
          attributes: {
            profiles: chunk.map(buildImportProfile),
          },
        },
      });
      jobs++;
    }
    return { requested: profiles.length, jobs };
  }

  async function bulkListMutation(
    endpoint: string,
    type: string,
    listId: string,
    emails: string[]
  ): Promise<{ requested: number; jobs: number }> {
    let jobs = 0;
    for (let i = 0; i < emails.length; i += BULK_SUBSCRIPTION_CHUNK) {
      const chunk = emails.slice(i, i + BULK_SUBSCRIPTION_CHUNK);
      await request("POST", `/${endpoint}/`, {
        data: {
          type,
          attributes: {
            profiles: {
              data: chunk.map((email) => ({
                type: "profile",
                attributes: { email },
              })),
            },
          },
          relationships: {
            list: { data: { type: "list", id: listId } },
          },
        },
      });
      jobs++;
    }
    return { requested: emails.length, jobs };
  }

  /** Subscribe profiles (created on demand) to a list via bulk job. */
  async function bulkSubscribe(
    listId: string,
    emails: string[]
  ): Promise<{ requested: number; jobs: number }> {
    return bulkListMutation(
      "profile-subscription-bulk-create-jobs",
      "profile-subscription-bulk-create-job",
      listId,
      emails
    );
  }

  /** Unsubscribe profiles from a list via bulk job. */
  async function bulkUnsubscribe(
    listId: string,
    emails: string[]
  ): Promise<{ requested: number; jobs: number }> {
    return bulkListMutation(
      "profile-subscription-bulk-delete-jobs",
      "profile-subscription-bulk-delete-job",
      listId,
      emails
    );
  }

  return { profileImport, bulkSubscribe, bulkUnsubscribe };
}

export type KlaviyoClient = ReturnType<typeof createKlaviyoClient>;
