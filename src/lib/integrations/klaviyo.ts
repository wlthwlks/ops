/**
 * Minimal Klaviyo REST client for the membership-list sync cron.
 *
 * Endpoints used (JSON:API, private API key):
 *   - POST  /api/profile-bulk-import-jobs/            bulk profile upsert job (10k/job)
 *   - GET   /api/profile-bulk-import-jobs/{job_id}    poll job status
 *   - GET   /api/profiles?filter=any(email,[...])     resolve profile ids by email
 *   - POST  /api/lists/{id}/relationships/profiles/   add profiles to a list (1000/call)
 *   - DELETE /api/lists/{id}/relationships/profiles/  remove profiles from a list (1000/call)
 *   - POST  /api/profile-subscription-bulk-delete-jobs/  global email unsubscribe (100/call)
 *
 * List membership add/remove endpoints do NOT touch email consent (unlike the
 * profile-subscription bulk jobs, which can globally unsubscribe profiles
 * that are not on the target list). The bulk unsubscribe job is the deliberate
 * consent-changing counterpart: profiles without the suppression checkboxes
 * are never passed to it.
 *
 * The bulk import job is async (202) — the caller waits for completion before
 * resolving profile ids so new profiles are guaranteed to exist.
 */

export interface KlaviyoConfig {
  /** Klaviyo private API key (pk_…). */
  apiKey: string;
  /** JSON:API revision (sent as the required `revision` header). */
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

export class KlaviyoJobTimeoutError extends Error {
  constructor(jobIds: string[], timeoutMs: number) {
    super(
      `Klaviyo bulk import job(s) did not complete within ${timeoutMs}ms: ${jobIds.join(", ")}`
    );
    this.name = "KlaviyoJobTimeoutError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PROFILE_IMPORT_CHUNK = 5000;
const EMAIL_FILTER_CHUNK = 100;
const LIST_MUTATION_CHUNK = 1000;
const UNSUBSCRIBE_CHUNK = 100;

type HttpMethod = "GET" | "POST" | "DELETE";

export function createKlaviyoClient(config: KlaviyoConfig) {
  const baseUrl = config.baseUrl ?? "https://a.klaviyo.com/api";
  const revision = config.revision ?? "2026-07-15";
  const maxRetries = config.maxRetries ?? 3;

  async function request(
    method: HttpMethod,
    path: string,
    body?: unknown,
    attempt = 0
  ): Promise<{ status: number; data: unknown }> {
    const url = `${baseUrl}${path}`;

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Klaviyo-API-Key ${config.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        revision,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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

    const text = await res.text().catch(() => "");
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      throw new KlaviyoApiError(res.status, res.statusText, text);
    }
    return { status: res.status, data };
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

  /**
   * Create bulk profile import job(s). Returns the async job ids — the caller
   * must waitForImportJobs before relying on the imported profiles.
   */
  async function importProfiles(
    profiles: KlaviyoProfileInput[]
  ): Promise<{ requested: number; jobs: number; jobIds: string[] }> {
    const jobIds: string[] = [];
    for (let i = 0; i < profiles.length; i += PROFILE_IMPORT_CHUNK) {
      const chunk = profiles.slice(i, i + PROFILE_IMPORT_CHUNK);
      const res = await request("POST", "/profile-bulk-import-jobs/", {
        data: {
          type: "profile-bulk-import-job",
          attributes: {
            profiles: {
              data: chunk.map((p) => ({
                type: "profile",
                attributes: buildImportProfile(p),
              })),
            },
          },
        },
      });
      const jobId = (res.data as { data?: { id?: string } })?.data?.id ?? "";
      if (!jobId) {
        throw new KlaviyoApiError(res.status, "OK", "Bulk import job id missing in response");
      }
      jobIds.push(jobId);
    }
    return { requested: profiles.length, jobs: jobIds.length, jobIds };
  }

  /** Poll import jobs until all are complete. Throws on timeout or cancellation. */
  async function waitForImportJobs(
    jobIds: string[],
    options?: { timeoutMs?: number; intervalMs?: number }
  ): Promise<void> {
    if (jobIds.length === 0) return;
    const timeoutMs = options?.timeoutMs ?? 240_000;
    const intervalMs = options?.intervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;

    const pending = new Set(jobIds);
    while (pending.size > 0) {
      for (const jobId of [...pending]) {
        const res = await request("GET", `/profile-bulk-import-jobs/${encodeURIComponent(jobId)}`);
        const status =
          (res.data as { data?: { attributes?: { status?: string } } })?.data?.attributes
            ?.status ?? "";
        if (status === "complete") {
          pending.delete(jobId);
        } else if (status === "cancelled" || status === "failed") {
          throw new KlaviyoApiError(res.status, "OK", `Bulk import job ${jobId} ${status}`);
        }
      }
      if (pending.size === 0) break;
      if (Date.now() >= deadline) {
        throw new KlaviyoJobTimeoutError([...pending], timeoutMs);
      }
      await sleep(intervalMs);
    }
  }

  /** Resolve profile ids for emails via GET /api/profiles (chunked any-filter, paginated). */
  async function listProfileIdsByEmails(emails: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (unique.length === 0) return map;

    for (let i = 0; i < unique.length; i += EMAIL_FILTER_CHUNK) {
      const chunk = unique.slice(i, i + EMAIL_FILTER_CHUNK);
      const list = chunk.map((e) => JSON.stringify(e)).join(",");
      const filter = encodeURIComponent(`any(email,[${list}])`);

      let cursor: string | undefined;
      do {
        const cursorParam = cursor
          ? `&page[cursor]=${encodeURIComponent(cursor)}`
          : "";
        const res = await request(
          "GET",
          `/profiles/?filter=${filter}&fields[profile]=id,email${cursorParam}`
        );
        const body = res.data as {
          data?: Array<{ id?: string; attributes?: { email?: string } }>;
          links?: { next?: string | null };
        };
        for (const item of body.data ?? []) {
          const email = (item.attributes?.email ?? "").trim().toLowerCase();
          if (email && item.id) map.set(email, item.id);
        }
        const nextUrl = body.links?.next;
        cursor = nextUrl
          ? new URLSearchParams(nextUrl.split("?")[1] ?? "").get("page[cursor]") ?? undefined
          : undefined;
      } while (cursor);
    }
    return map;
  }

  async function mutateListMembership(
    method: "POST" | "DELETE",
    listId: string,
    profileIds: string[]
  ): Promise<{ requested: number; calls: number }> {
    let calls = 0;
    for (let i = 0; i < profileIds.length; i += LIST_MUTATION_CHUNK) {
      const chunk = profileIds.slice(i, i + LIST_MUTATION_CHUNK);
      await request(
        method,
        `/lists/${encodeURIComponent(listId)}/relationships/profiles/`,
        {
          data: chunk.map((id) => ({ type: "profile", id })),
        }
      );
      calls++;
    }
    return { requested: profileIds.length, calls };
  }

  /** Add profiles to a list (pure membership — does not change consent). */
  async function addProfilesToList(
    listId: string,
    profileIds: string[]
  ): Promise<{ requested: number; calls: number }> {
    return mutateListMembership("POST", listId, profileIds);
  }

  /** Remove profiles from a list (pure membership — does not change consent). */
  async function removeProfilesFromList(
    listId: string,
    profileIds: string[]
  ): Promise<{ requested: number; calls: number }> {
    return mutateListMembership("DELETE", listId, profileIds);
  }

  /**
   * Globally unsubscribe emails from email marketing. No list relationship is
   * provided, so every profile in the job is unsubscribed regardless of list
   * membership. Missing profiles are created already-unsubscribed. Idempotent:
   * profiles that are already unsubscribed simply stay unsubscribed.
   */
  async function unsubscribeProfilesFromEmail(
    emails: string[]
  ): Promise<{ requested: number; calls: number }> {
    let calls = 0;
    for (let i = 0; i < emails.length; i += UNSUBSCRIBE_CHUNK) {
      const chunk = emails.slice(i, i + UNSUBSCRIBE_CHUNK);
      await request("POST", "/profile-subscription-bulk-delete-jobs/", {
        data: {
          type: "profile-subscription-bulk-delete-job",
          attributes: {
            profiles: {
              data: chunk.map((email) => ({
                type: "profile",
                attributes: {
                  email,
                  subscriptions: {
                    email: { marketing: { consent: "UNSUBSCRIBED" } },
                  },
                },
              })),
            },
          },
        },
      });
      calls++;
    }
    return { requested: emails.length, calls };
  }

  return {
    importProfiles,
    waitForImportJobs,
    listProfileIdsByEmails,
    addProfilesToList,
    removeProfilesFromList,
    unsubscribeProfilesFromEmail,
  };
}

export type KlaviyoClient = ReturnType<typeof createKlaviyoClient>;
