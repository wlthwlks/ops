import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createKlaviyoClient, KlaviyoApiError } from "@/lib/integrations/klaviyo";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function okResponse() {
  return Promise.resolve({
    ok: true,
    status: 202,
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

  it("uses the Klaviyo-API-Key auth header and revision query param", async () => {
    mockFetch.mockImplementation(okResponse);
    await client.profileImport([{ email: "a@x.com" }]);
    const [url, init] = mockFetch.mock.calls[0];
    expect(String(url)).toContain("https://a.klaviyo.test/api/profile-import/?revision=2025-04-15");
    expect(init.headers.Authorization).toBe("Klaviyo-API-Key pk_test123");
  });

  it("profileImport sends email, name, phone, location and properties", async () => {
    mockFetch.mockImplementation(okResponse);
    await client.profileImport([
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
    const profile = body.data.attributes.profiles[0];
    expect(body.data.type).toBe("profile-import");
    expect(profile.email).toBe("dina@x.com");
    expect(profile.first_name).toBe("Dina");
    expect(profile.last_name).toBe("K");
    expect(profile.phone_number).toBe("+13105551234");
    expect(profile.location).toEqual({ city: "Santa Monica", zip: "90401", country: "United States" });
    expect(profile.properties.membership_status).toBe("active");
  });

  it("chunks profile imports at 5000 per request", async () => {
    mockFetch.mockImplementation(okResponse);
    const profiles = Array.from({ length: 5001 }, (_, i) => ({ email: `p${i}@x.com` }));
    const result = await client.profileImport(profiles);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const first = JSON.parse(mockFetch.mock.calls[0][1].body);
    const second = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(first.data.attributes.profiles).toHaveLength(5000);
    expect(second.data.attributes.profiles).toHaveLength(1);
    expect(result).toEqual({ requested: 5001, jobs: 2 });
  });

  it("bulkSubscribe chunks at 1000 and references the list", async () => {
    mockFetch.mockImplementation(okResponse);
    const emails = Array.from({ length: 1001 }, (_, i) => `m${i}@x.com`);
    const result = await client.bulkSubscribe("list_active", emails);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data.type).toBe("profile-subscription-bulk-create-job");
    expect(body.data.relationships.list.data).toEqual({ type: "list", id: "list_active" });
    expect(body.data.attributes.profiles.data[0]).toEqual({
      type: "profile",
      attributes: { email: "m0@x.com" },
    });
    expect(body.data.attributes.profiles.data).toHaveLength(1000);
    expect(result).toEqual({ requested: 1001, jobs: 2 });
  });

  it("bulkUnsubscribe uses the delete job endpoint", async () => {
    mockFetch.mockImplementation(okResponse);
    await client.bulkUnsubscribe("list_churned", ["a@x.com"]);
    const [url, ,] = mockFetch.mock.calls[0];
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(String(url)).toContain("/profile-subscription-bulk-delete-jobs/");
    expect(body.data.type).toBe("profile-subscription-bulk-delete-job");
  });

  it("retries on 429 after Retry-After delay", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => "",
        headers: { get: () => "2" },
      } as unknown as Response)
      .mockImplementation(okResponse);

    const promise = client.bulkSubscribe("list_active", ["a@x.com"]);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.jobs).toBe(1);
  });

  it("throws KlaviyoApiError on 4xx with body", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      text: async () => '{"errors":[{"detail":"bad list id"}]}',
      headers: { get: () => null },
    } as unknown as Response);
    await expect(client.bulkSubscribe("bad", ["a@x.com"])).rejects.toThrow(KlaviyoApiError);
    await expect(client.bulkSubscribe("bad", ["a@x.com"])).rejects.toThrow("bad list id");
  });
});
