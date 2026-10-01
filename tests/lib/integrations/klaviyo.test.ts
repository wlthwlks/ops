import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createKlaviyoClient,
  KlaviyoApiError,
  KlaviyoJobTimeoutError,
} from "@/lib/integrations/klaviyo";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function jsonResponse(status: number, data: unknown) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(data),
    headers: { get: () => null },
  } as unknown as Response);
}

function emptyResponse(status: number) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: async () => "",
    headers: { get: () => null },
  } as unknown as Response);
}

describe("KlaviyoClient", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const client = createKlaviyoClient({ apiKey: "pk_test123", baseUrl: "https://a.klaviyo.test/api" });

  it("uses the Klaviyo-API-Key auth header and revision header", async () => {
    mockFetch.mockImplementation(() => jsonResponse(202, { data: { id: "job1", attributes: { status: "queued" } } }));
    await client.importProfiles([{ email: "a@x.com" }]);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("https://a.klaviyo.test/api/profile-bulk-import-jobs/");
    expect(init.headers.Authorization).toBe("Klaviyo-API-Key pk_test123");
    expect(init.headers.revision).toBe("2026-07-15");
  });

  it("allows a custom revision via config", async () => {
    mockFetch.mockImplementation(() => jsonResponse(202, { data: { id: "job1", attributes: { status: "queued" } } }));
    const custom = createKlaviyoClient({
      apiKey: "pk_test123",
      baseUrl: "https://a.klaviyo.test/api",
      revision: "2025-01-15",
    });
    await custom.importProfiles([{ email: "a@x.com" }]);
    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.revision).toBe("2025-01-15");
  });

  it("importProfiles sends the bulk-import-job payload with profile attributes", async () => {
    mockFetch.mockImplementation(() => jsonResponse(202, { data: { id: "job1", attributes: { status: "queued" } } }));
    await client.importProfiles([
      {
        email: "dina@x.com",
        firstName: "Dina",
        lastName: "K",
        phoneNumber: "+13105551234",
        city: "Santa Monica",
        zip: "90401",
        country: "United States",
        properties: { membership_status: "active", service_access_until: "2026-09-01T00:00:00.000Z" },
      },
    ]);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data.type).toBe("profile-bulk-import-job");
    const profile = body.data.attributes.profiles.data[0];
    expect(profile.type).toBe("profile");
    expect(profile.attributes.email).toBe("dina@x.com");
    expect(profile.attributes.first_name).toBe("Dina");
    expect(profile.attributes.phone_number).toBe("+13105551234");
    expect(profile.attributes.location).toEqual({ city: "Santa Monica", zip: "90401", country: "United States" });
    expect(profile.attributes.properties.membership_status).toBe("active");
  });

  it("chunks imports at 5000 per job and returns job ids", async () => {
    mockFetch.mockImplementation(() => jsonResponse(202, { data: { id: "job1", attributes: { status: "queued" } } }));
    const profiles = Array.from({ length: 5001 }, (_, i) => ({ email: `p${i}@x.com` }));
    const result = await client.importProfiles(profiles);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const first = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(first.data.attributes.profiles.data).toHaveLength(5000);
    expect(result).toEqual({ requested: 5001, jobs: 2, jobIds: ["job1", "job1"] });
  });

  it("waitForImportJobs polls until every job is complete", async () => {
    mockFetch
      .mockImplementationOnce(() => jsonResponse(200, { data: { id: "job1", attributes: { status: "processing" } } }))
      .mockImplementationOnce(() => jsonResponse(200, { data: { id: "job2", attributes: { status: "queued" } } }))
      .mockImplementationOnce(() => jsonResponse(200, { data: { id: "job1", attributes: { status: "complete" } } }))
      .mockImplementationOnce(() => jsonResponse(200, { data: { id: "job2", attributes: { status: "complete" } } }));

    const promise = client.waitForImportJobs(["job1", "job2"], { intervalMs: 1000, timeoutMs: 60_000 });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("waitForImportJobs throws on timeout", async () => {
    mockFetch.mockImplementation(() => jsonResponse(200, { data: { id: "job1", attributes: { status: "processing" } } }));
    const promise = client.waitForImportJobs(["job1"], { intervalMs: 1000, timeoutMs: 5000 });
    const assertion = expect(promise).rejects.toThrow(KlaviyoJobTimeoutError);
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });

  it("listProfileIdsByEmails chunks the email filter and follows pagination", async () => {
    mockFetch
      .mockImplementationOnce(() =>
        jsonResponse(200, {
          data: [
            { id: "p1", type: "profile", attributes: { email: "a@x.com" } },
            { id: "p2", type: "profile", attributes: { email: "b@x.com" } },
          ],
          links: { next: "https://a.klaviyo.test/api/profiles/?page%5Bcursor%5D=next_cur" },
        })
      )
      .mockImplementationOnce(() =>
        jsonResponse(200, {
          data: [{ id: "p3", type: "profile", attributes: { email: "c@x.com" } }],
          links: { next: null },
        })
      );

    const map = await client.listProfileIdsByEmails(["A@X.com", "b@x.com", "c@x.com"]);
    expect(map.get("a@x.com")).toBe("p1");
    expect(map.get("b@x.com")).toBe("p2");
    expect(map.get("c@x.com")).toBe("p3");

    const firstUrl = String(mockFetch.mock.calls[0][0]);
    expect(firstUrl).toContain("filter=any(email%2C%5B%22a%40x.com%22%2C%22b%40x.com%22%2C%22c%40x.com%22%5D)");
    expect(firstUrl).toContain("fields[profile]=id,email");
    expect(String(mockFetch.mock.calls[1][0])).toContain("page[cursor]=next_cur");
  });

  it("chunks email id lookups at 100 emails per filter request", async () => {
    mockFetch.mockImplementation(() =>
      jsonResponse(200, { data: [], links: { next: null } })
    );
    const emails = Array.from({ length: 101 }, (_, i) => `m${i}@x.com`);
    await client.listProfileIdsByEmails(emails);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstUrl = String(mockFetch.mock.calls[0][0]);
    expect(firstUrl).toContain("m99%40x.com");
    expect(firstUrl).not.toContain("m100%40x.com");
    expect(String(mockFetch.mock.calls[1][0])).toContain("m100%40x.com");
  });

  it("addProfilesToList chunks at 1000 and sends profile ids", async () => {
    mockFetch.mockImplementation(() => emptyResponse(204));
    const ids = Array.from({ length: 1001 }, (_, i) => `prof_${i}`);
    const result = await client.addProfilesToList("list_a", ids);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("https://a.klaviyo.test/api/lists/list_a/relationships/profiles/");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.data).toHaveLength(1000);
    expect(body.data[0]).toEqual({ type: "profile", id: "prof_0" });
    expect(result).toEqual({ requested: 1001, calls: 2 });
  });

  it("removeProfilesFromList uses DELETE with profile ids", async () => {
    mockFetch.mockImplementation(() => emptyResponse(204));
    const result = await client.removeProfilesFromList("list_a", ["prof_1", "prof_2"]);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("https://a.klaviyo.test/api/lists/list_a/relationships/profiles/");
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(init.body)).toEqual({
      data: [
        { type: "profile", id: "prof_1" },
        { type: "profile", id: "prof_2" },
      ],
    });
    expect(result).toEqual({ requested: 2, calls: 1 });
  });

  it("retries on 429 after Retry-After delay", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "",
        headers: { get: () => "2" },
      } as unknown as Response)
      .mockImplementation(() => emptyResponse(204));

    const promise = client.removeProfilesFromList("list_a", ["prof_1"]);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.calls).toBe(1);
  });

  it("retries on transient network errors (ECONNRESET)", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockImplementation(() => jsonResponse(200, { data: [], links: { next: null } }));

    const promise = client.listProfilesInList("list_a");
    await vi.advanceTimersByTimeAsync(1000);
    const emails = await promise;
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(emails.size).toBe(0);
  });

  it("throws KlaviyoApiError on 4xx with body", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => '{"errors":[{"detail":"bad list id"}]}',
      headers: { get: () => null },
    } as unknown as Response);
    await expect(client.addProfilesToList("bad", ["prof_1"])).rejects.toThrow(KlaviyoApiError);
    await expect(client.addProfilesToList("bad", ["prof_1"])).rejects.toThrow("bad list id");
  });

  it("suppressProfilesByEmail sends the suppression job payload with emails", async () => {
    mockFetch.mockImplementation(() => jsonResponse(202, { data: { id: "sj1", attributes: { status: "queued" } } }));
    const result = await client.suppressProfilesByEmail(["a@x.com", "b@x.com"]);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toBe("https://a.klaviyo.test/api/profile-suppression-bulk-create-jobs/");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.data.type).toBe("profile-suppression-bulk-create-job");
    expect(body.data.attributes.profiles.data).toEqual([
      { type: "profile", attributes: { email: "a@x.com" } },
      { type: "profile", attributes: { email: "b@x.com" } },
    ]);
    expect(result).toEqual({ requested: 2, calls: 1, jobIds: ["sj1"] });
  });

  it("suppressProfilesByEmail chunks at 100 emails and dedupes", async () => {
    mockFetch.mockImplementation(() => jsonResponse(202, { data: { id: "sj1", attributes: { status: "queued" } } }));
    const emails = Array.from({ length: 100 }, (_, i) => `p${i}@x.com`).concat(["p0@x.com"]);
    const result = await client.suppressProfilesByEmail(emails);
    expect(result.requested).toBe(100);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data.attributes.profiles.data).toHaveLength(100);
  });

  it("listAllProfilesForAudit parses subscription state and follows pagination", async () => {
    mockFetch
      .mockImplementationOnce(() =>
        jsonResponse(200, {
          data: [
            {
              type: "profile",
              attributes: {
                email: "sub@x.com",
                subscriptions: {
                  email: { marketing: { consent: "SUBSCRIBED", can_receive_email_marketing: true, suppression: [], list_suppressions: [] } },
                },
              },
            },
            {
              type: "profile",
              attributes: {
                email: "sup@x.com",
                subscriptions: {
                  email: { marketing: { consent: "SUPPRESSED", can_receive_email_marketing: false, suppression: [{ reason: "USER_SUPPRESSED" }], list_suppressions: [] } },
                },
              },
            },
          ],
          links: { next: "https://a.klaviyo.test/api/profiles/?page%5Bcursor%5D=next_cur" },
        })
      )
      .mockImplementationOnce(() =>
        jsonResponse(200, {
          data: [
            {
              type: "profile",
              attributes: {
                email: "unsub@x.com",
                subscriptions: {
                  email: { marketing: { consent: "UNSUBSCRIBED", can_receive_email_marketing: false, suppression: [], list_suppressions: [] } },
                },
              },
            },
          ],
          links: { next: null },
        })
      );

    const entries = await client.listAllProfilesForAudit();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ email: "sub@x.com", consent: "SUBSCRIBED", suppressed: false, canReceiveEmailMarketing: true });
    expect(entries[1].suppressed).toBe(true);
    expect(entries[1].canReceiveEmailMarketing).toBe(false);
    expect(entries[2]).toEqual({ email: "unsub@x.com", consent: "UNSUBSCRIBED", suppressed: false, canReceiveEmailMarketing: false });

    const firstUrl = String(mockFetch.mock.calls[0][0]);
    expect(firstUrl).toContain("additional-fields[profile]=subscriptions");
    expect(String(mockFetch.mock.calls[1][0])).toContain("page[cursor]=next_cur");
  });

  it("listAllProfilesForAudit retries a page that returns an empty body", async () => {
    mockFetch
      .mockImplementationOnce(() => emptyResponse(200))
      .mockImplementationOnce(() => jsonResponse(200, { data: [], links: { next: null } }));

    const promise = client.listAllProfilesForAudit();
    await vi.advanceTimersByTimeAsync(1000);
    const entries = await promise;
    expect(entries).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("listAllProfilesForAudit starts from a startCursor", async () => {
    mockFetch.mockImplementation(() => jsonResponse(200, { data: [], links: { next: null } }));
    await client.listAllProfilesForAudit({ startCursor: "cur_123" });
    const [url] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("page[cursor]=cur_123");
  });
});
