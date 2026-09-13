import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  getSweatpalsApiConfig,
  getZapierFeed,
  listCommunities,
  resetCommunityIdCache,
  resolveCommunityId,
  SweatpalsApiError,
} from "@/lib/integrations/sweatpals";

const fetchMock = vi.fn();

vi.stubGlobal("fetch", fetchMock);

function jsonResponse(status: number, body: unknown) {
  return { status, json: async () => body } as unknown as Response;
}

describe("getSweatpalsApiConfig", () => {
  const prevKey = process.env.SWEATPALS_API_KEY;
  const prevBase = process.env.SWEATPALS_API_BASE;

  beforeEach(() => {
    process.env.SWEATPALS_API_KEY = "sp_key";
    resetCommunityIdCache();
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.SWEATPALS_API_KEY;
    else process.env.SWEATPALS_API_KEY = prevKey;
    if (prevBase === undefined) delete process.env.SWEATPALS_API_BASE;
    else process.env.SWEATPALS_API_BASE = prevBase;
    vi.clearAllMocks();
  });

  it("requires only the API key", () => {
    delete process.env.SWEATPALS_COMMUNITY_ID;
    const cfg = getSweatpalsApiConfig();
    expect(cfg.apiKey).toBe("sp_key");
    expect(cfg.communityId).toBe("");
  });

  it("normalizes a trailing /api on the base host", () => {
    process.env.SWEATPALS_API_BASE = "https://ilove.staging.sweatpals.com/api/";
    const cfg = getSweatpalsApiConfig();
    expect(cfg.apiBase).toBe("https://ilove.staging.sweatpals.com");
  });

  it("throws when the API key is missing", () => {
    delete process.env.SWEATPALS_API_KEY;
    expect(() => getSweatpalsApiConfig()).toThrow(/SWEATPALS_API_KEY/);
  });
});

describe("resolveCommunityId", () => {
  const prevKey = process.env.SWEATPALS_API_KEY;

  beforeEach(() => {
    process.env.SWEATPALS_API_KEY = "sp_key";
    delete process.env.SWEATPALS_COMMUNITY_ID;
    resetCommunityIdCache();
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.SWEATPALS_API_KEY;
    else process.env.SWEATPALS_API_KEY = prevKey;
    delete process.env.SWEATPALS_COMMUNITY_ID;
  });

  it("uses the env override when set", async () => {
    process.env.SWEATPALS_COMMUNITY_ID = "env-community-id";
    expect(await resolveCommunityId()).toBe("env-community-id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves and caches from /api/external/communities", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [{ id: "comm-1", userName: "wlth" }])
    );
    expect(await resolveCommunityId()).toBe("comm-1");
    expect(await resolveCommunityId()).toBe("comm-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed on multiple communities", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [{ id: "comm-1" }, { id: "comm-2" }])
    );
    await expect(resolveCommunityId()).rejects.toThrow(/SWEATPALS_COMMUNITY_ID/);
  });
});

describe("listCommunities / getZapierFeed", () => {
  const prevKey = process.env.SWEATPALS_API_KEY;

  beforeEach(() => {
    process.env.SWEATPALS_API_KEY = "sp_key";
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (prevKey === undefined) delete process.env.SWEATPALS_API_KEY;
    else process.env.SWEATPALS_API_KEY = prevKey;
  });

  it("lists communities with the x-api-key header", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [{ id: "comm-1", userName: "wlth" }])
    );
    const list = await listCommunities();
    expect(list[0].id).toBe("comm-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/external/communities");
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "sp_key" });
  });

  it("returns feed rows", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, [
        { id: "row-1", user_email: "a@b.com", createdAt: "2026-09-13T00:00:00.000Z" },
      ])
    );
    const rows = await getZapierFeed("new-members", { page: 1, pageSize: 100 });
    expect(rows).toHaveLength(1);
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/zapier-provider/new-members?pageSize=100&page=1");
  });

  it("throws SweatpalsApiError on 401", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { message: "Unauthorized" }));
    await expect(getZapierFeed("cancelled-members")).rejects.toBeInstanceOf(
      SweatpalsApiError
    );
  });
});
