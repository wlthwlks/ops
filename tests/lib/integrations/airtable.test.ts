import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAirtableClient } from "@/lib/integrations/airtable";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("AirtableClient", () => {
  const client = createAirtableClient({ apiKey: "pat_test", baseId: "appTEST" });

  beforeEach(() => { vi.clearAllMocks(); });

  it("fetches records from a table", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, json: async () => ({ records: [{ id: "rec1", fields: { Name: "Alice" } }, { id: "rec2", fields: { Name: "Bob" } }] }),
    });
    const records = await client.listRecords("Members");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(2);
    expect(records[0].fields.Name).toBe("Alice");
  });

  it("handles pagination with offset", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ records: [{ id: "rec1", fields: { Name: "Alice" } }], offset: "page2" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ records: [{ id: "rec2", fields: { Name: "Bob" } }] }) });
    const records = await client.listRecords("Members");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(2);
  });

  it("applies filterByFormula", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ records: [] }) });
    await client.listRecords("Members", { filterByFormula: "{Status} = 'Active'" });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("filterByFormula");
  });

  it("retries on 429 rate limit", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ records: [] }) });
    const records = await client.listRecords("Members");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(0);
  });

  it("throws on non-retryable error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "invalid api key" });
    await expect(client.listRecords("Members")).rejects.toThrow("401");
  });
});
