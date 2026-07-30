import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAirtableClient,
  isPermanentAirtableStatus,
  AirtableHttpError,
  AirtableTimeoutError,
} from "@/lib/integrations/airtable";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("isPermanentAirtableStatus", () => {
  it("treats 4xx except 429 as permanent", () => {
    expect(isPermanentAirtableStatus(400)).toBe(true);
    expect(isPermanentAirtableStatus(401)).toBe(true);
    expect(isPermanentAirtableStatus(403)).toBe(true);
    expect(isPermanentAirtableStatus(404)).toBe(true);
    expect(isPermanentAirtableStatus(422)).toBe(true);
    expect(isPermanentAirtableStatus(429)).toBe(false);
    expect(isPermanentAirtableStatus(500)).toBe(false);
  });
});

describe("AirtableClient", () => {
  const client = createAirtableClient({
    apiKey: "pat_test",
    baseId: "appTEST",
    rateLimitMinWaitMs: 1,
    requestTimeoutMs: 100,
    maxRetries: 3,
    batchGapMs: 0,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches records from a table", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        records: [
          { id: "rec1", fields: { Name: "Alice" } },
          { id: "rec2", fields: { Name: "Bob" } },
        ],
      }),
      headers: { get: () => null },
    });
    const records = await client.listRecords("Members");
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(2);
    expect(records[0].fields.Name).toBe("Alice");
  });

  it("handles pagination with offset", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          records: [{ id: "rec1", fields: { Name: "Alice" } }],
          offset: "page2",
        }),
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ records: [{ id: "rec2", fields: { Name: "Bob" } }] }),
        headers: { get: () => null },
      });
    const records = await client.listRecords("Members");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(2);
  });

  it("applies filterByFormula", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ records: [] }),
      headers: { get: () => null },
    });
    await client.listRecords("Members", { filterByFormula: "{Status} = 'Active'" });
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("filterByFormula");
  });

  it("retries on 429 rate limit with backoff", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
        headers: { get: () => null },
        text: async () => "rate limited",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ records: [] }),
        headers: { get: () => null },
      });
    const records = await client.listRecords("Members");
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(0);
  });

  it("does not repeatedly retry permanent 4xx", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      headers: { get: () => null },
      text: async () => "invalid field",
    });
    await expect(client.listRecords("Members")).rejects.toBeInstanceOf(AirtableHttpError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws on non-retryable error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      headers: { get: () => null },
      text: async () => "invalid api key",
    });
    await expect(client.listRecords("Members")).rejects.toThrow("401");
  });

  it("batches updates in groups of 10 and throttles", async () => {
    const updates = Array.from({ length: 25 }, (_, i) => ({
      id: `rec${i}`,
      fields: { "Stripe Customer ID": `cus_${i}` },
    }));

    mockFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ records: [] }),
      headers: { get: () => null },
    }));

    const gaps: number[] = [];
    const started = Date.now();
    const progress: number[] = [];

    // Use gapMs > 0 to prove throttle
    const throttled = createAirtableClient({
      apiKey: "pat_test",
      baseId: "appTEST",
      rateLimitMinWaitMs: 1,
      batchGapMs: 20,
      requestTimeoutMs: 5000,
    });

    await throttled.updateRecordsBatched("Members", updates, {
      batchSize: 10,
      gapMs: 20,
      onBatch: (info) => progress.push(info.batchIndex),
    });

    // 3 batches for 25 records
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(progress).toEqual([1, 2, 3]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30); // ~2 gaps
    void gaps;
  });

  it("updateRecordsBatchedDetailed reports partial success", async () => {
    const updates = Array.from({ length: 15 }, (_, i) => ({
      id: `rec${i}`,
      fields: { "Stripe Customer ID": `cus_${i}` },
    }));

    let call = 0;
    mockFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        call++;
        if (call === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              records: updates.slice(0, 10).map((u) => ({ id: u.id, fields: u.fields })),
            }),
            headers: { get: () => null },
          };
        }
        return {
          ok: false,
          status: 500,
          statusText: "Error",
          headers: { get: () => null },
          text: async () => "server error",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ records: [] }),
        headers: { get: () => null },
      };
    });

    const c = createAirtableClient({
      apiKey: "pat_test",
      baseId: "appTEST",
      rateLimitMinWaitMs: 1,
      maxRetries: 0,
      batchGapMs: 0,
      requestTimeoutMs: 5000,
    });

    const result = await c.updateRecordsBatchedDetailed("Members", updates, {
      batchSize: 10,
      gapMs: 0,
    });
    expect(result.successIds).toHaveLength(10);
    expect(result.failedBatchIndex).toBe(2);
    expect(result.error).toBeTruthy();
  });

  it("aborts hanging requests via timeout", async () => {
    mockFetch.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
          // never resolve otherwise
        })
    );

    const c = createAirtableClient({
      apiKey: "pat_test",
      baseId: "appTEST",
      requestTimeoutMs: 30,
      rateLimitMinWaitMs: 1,
      maxRetries: 0,
    });

    await expect(c.listRecords("Members")).rejects.toBeInstanceOf(AirtableTimeoutError);
  }, 10_000);
});
