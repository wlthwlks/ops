import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStrapiClient } from "@/lib/integrations/strapi";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("StrapiClient", () => {
  const client = createStrapiClient({ baseUrl: "http://localhost:1337", token: "test-token" });
  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches entries", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 1 }, { id: 2 }] }) });
    const entries = await client.find("members");
    expect(entries.data).toHaveLength(2);
  });

  it("creates an entry", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 3 } }) });
    await client.create("members", { name: "Charlie" });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.data.name).toBe("Charlie");
  });

  it("updates an entry", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { id: 1 } }) });
    await client.update("members", 1, { name: "Updated" });
    expect(mockFetch.mock.calls[0][1].method).toBe("PUT");
  });

  it("sends auth header", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [] }) });
    await client.find("members");
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer test-token");
  });

  it("throws on error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, statusText: "Forbidden" });
    await expect(client.find("members")).rejects.toThrow("403");
  });
});
