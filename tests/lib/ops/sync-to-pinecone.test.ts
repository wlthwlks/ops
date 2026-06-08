import { describe, it, expect, vi, beforeEach } from "vitest";
import { runPineconeSync } from "@/lib/ops/sync-to-pinecone";

vi.mock("@/lib/integrations/airtable");
vi.mock("@/lib/integrations/pinecone");
vi.mock("@/lib/integrations/openai-embeddings");
vi.mock("@/lib/geo/geocode");
vi.mock("@/lib/geo/nearby");

const { createAirtableClient } = await import("@/lib/integrations/airtable");
const { createPineconeClient } = await import("@/lib/integrations/pinecone");
const { embedTexts } = await import("@/lib/integrations/openai-embeddings");
const { geocode } = await import("@/lib/geo/geocode");
const { findNearbyPlaces } = await import("@/lib/geo/nearby");

function makeCtx() {
  const logs: string[] = [];
  return { log: async (msg: string) => { logs.push(msg); }, db: {} as any, logs };
}

const BASE_ENV = {
  AIRTABLE_GET_DATA_TOKEN: "at-token",
  AIRTABLE_BASE_ID: "base-id",
  PINECONE_API_KEY: "pc-key",
  PINECONE_INDEX_NAME: "pc-index",
  OPENAI_API_KEY: "oai-key",
};

function makeAirtable(activeRecords: any[], cancelledRecords: any[] = []) {
  return {
    listRecords: vi.fn().mockImplementation((table: string, opts?: any) => {
      const formula = opts?.filterByFormula ?? "";
      // "Cancellation date" != "" identifies the cancelled-sweep filter.
      // The active-fetch filter requires "Cancellation date" = "" — same field, different operator.
      if (formula.includes('{Cancellation date} != ""')) return Promise.resolve(cancelledRecords);
      return Promise.resolve(activeRecords);
    }),
  };
}

function makePinecone(
  existingMeta: Map<string, any> = new Map(),
  fetchResult: any = null,
  allIds: string[] = []
) {
  return {
    fetchMetadataByIds: vi.fn().mockResolvedValue(existingMeta),
    fetchById: vi.fn().mockResolvedValue(fetchResult ?? { id: "r1", values: new Array(1536).fill(0.1), metadata: {} }),
    upsertVectors: vi.fn().mockResolvedValue(1),
    deleteByIds: vi.fn().mockResolvedValue(undefined),
    queryByVector: vi.fn().mockResolvedValue([]),
    listAllIds: vi.fn().mockResolvedValue(allIds),
  };
}

describe("runPineconeSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const [k, v] of Object.entries(BASE_ENV)) process.env[k] = v;
    vi.mocked(embedTexts).mockResolvedValue([new Array(1536).fill(0.2)]);
    vi.mocked(geocode).mockResolvedValue({ lat: 51.5, lon: -0.1, displayName: "London" });
    vi.mocked(findNearbyPlaces).mockResolvedValue("Shoreditch | Old Street");
  });

  it("members with unchanged location go into metadataOnly, not needsReEmbed (no Places API call)", async () => {
    const record = {
      id: "r1",
      fields: { email: "a@test.com", Name: "Alice", "post code": "EC1V", City: "London", Industry: "Tech", Revenue: "50k" },
    };
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtable([record]) as any);
    // Existing metadata with matching city/postcode and nearbyLocation set
    const existingMeta = new Map([
      ["r1", { city: "london", postcode: "ec1v", nearbyLocation: "Shoreditch", industry: "Finance", traction: "10k" }],
    ]);
    vi.mocked(createPineconeClient).mockReturnValue(makePinecone(existingMeta) as any);

    const ctx = makeCtx();
    const result = await runPineconeSync("London", ctx);

    expect(result.success).toBe(true);
    // No geocode call for metadataOnly path
    expect(geocode).not.toHaveBeenCalled();
    expect(findNearbyPlaces).not.toHaveBeenCalled();
    // embedTexts not called — no re-embed
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it("normalizeLocationField: 'London ' (trailing space) equals 'London' — no spurious re-embed", async () => {
    const record = {
      id: "r2",
      fields: { email: "b@test.com", Name: "Bob", "post code": "EC2A", City: "London ", Industry: "Retail", Revenue: "5k" },
    };
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtable([record]) as any);
    // Stored metadata has "London" (no trailing space)
    const existingMeta = new Map([
      ["r2", { city: "london", postcode: "ec2a", nearbyLocation: "Shoreditch", industry: "Retail", traction: "5k" }],
    ]);
    vi.mocked(createPineconeClient).mockReturnValue(makePinecone(existingMeta) as any);

    const ctx = makeCtx();
    const result = await runPineconeSync("London", ctx);

    expect(result.success).toBe(true);
    // "London " and "London" should be equal after normalization → no re-embed
    expect(embedTexts).not.toHaveBeenCalled();
    expect(geocode).not.toHaveBeenCalled();
  });

  it("cancelled members are deleted from Pinecone first", async () => {
    const cancelledRecord = {
      id: "r-cancel",
      fields: { email: "gone@test.com", City: "London", "Cancellation date": "2026-05-01" },
    };
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtable([], [cancelledRecord]) as any);
    const pinecone = makePinecone();
    vi.mocked(createPineconeClient).mockReturnValue(pinecone as any);

    const ctx = makeCtx();
    const result = await runPineconeSync("London", ctx);

    expect(result.success).toBe(true);
    expect(pinecone.deleteByIds).toHaveBeenCalledWith(["r-cancel"]);
  });

  it("new member (not in Pinecone) goes into needsReEmbed and gets embedded", async () => {
    const record = {
      id: "r-new",
      fields: { email: "new@test.com", Name: "New", "post code": "SW1A", City: "London", Industry: "Media", Revenue: "0" },
    };
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtable([record]) as any);
    // Empty map → member not in Pinecone
    vi.mocked(createPineconeClient).mockReturnValue(makePinecone(new Map()) as any);

    const ctx = makeCtx();
    const result = await runPineconeSync("London", ctx);

    expect(result.success).toBe(true);
    expect(embedTexts).toHaveBeenCalledOnce();
  });

  it("preserves existing nearbyLocation when new lookup returns empty (defensive)", async () => {
    // Existing record HAS a nearby string; new sync triggers re-embed (e.g.
    // city changed), but geocoding/findNearbyPlaces fails this run.
    const record = {
      id: "r1",
      fields: { email: "a@test.com", Name: "Alice", "post code": "EC1V", City: "London Town", Industry: "Tech", Revenue: "50k" },
    };
    const existingMeta = new Map([
      ["r1", { email: "a@test.com", city: "London", postcode: "EC1V", industry: "Tech", traction: "50k", nearbyLocation: "Bondi, Sydney CBD" }],
    ]);
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtable([record]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePinecone(existingMeta) as any);
    // Force the new lookup to return nothing.
    vi.mocked(findNearbyPlaces).mockResolvedValueOnce("");

    const ctx = makeCtx();
    await runPineconeSync("London", ctx);

    const upserted = vi.mocked(createPineconeClient).mock.results[0]!.value.upsertVectors.mock.calls[0]![0];
    expect(upserted[0].metadata.nearbyLocation).toBe("Bondi, Sydney CBD");
  });

  it("writes empty nearbyLocation for a new member when geocoding returns empty (no fallback)", async () => {
    const record = {
      id: "r-new",
      fields: { email: "new@test.com", Name: "New", "post code": "SW1A", City: "London", Industry: "Media", Revenue: "0" },
    };
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtable([record]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePinecone(new Map()) as any);
    vi.mocked(findNearbyPlaces).mockResolvedValueOnce("");

    const ctx = makeCtx();
    await runPineconeSync("London", ctx);

    const upserted = vi.mocked(createPineconeClient).mock.results[0]!.value.upsertVectors.mock.calls[0]![0];
    expect(upserted[0].metadata.nearbyLocation).toBe("");
  });

  it("reconciliation: deletes Pinecone IDs not in Airtable Active+Paid set (orphans)", async () => {
    const record = {
      id: "r1",
      fields: { email: "a@test.com", Name: "Alice", "post code": "EC1V", City: "London", Industry: "Tech", Revenue: "50k" },
    };
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtable([record]) as any);
    // Pinecone has r1 (kept) + r-orphan-1, r-orphan-2 (should be deleted)
    const pinecone = makePinecone(new Map(), null, ["r1", "r-orphan-1", "r-orphan-2"]);
    vi.mocked(createPineconeClient).mockReturnValue(pinecone as any);

    const ctx = makeCtx();
    await runPineconeSync("London", ctx);

    expect(pinecone.deleteByIds).toHaveBeenCalledWith(["r-orphan-1", "r-orphan-2"]);
  });

  it("reconciliation: no orphan delete call when Pinecone matches Airtable exactly", async () => {
    const record = {
      id: "r1",
      fields: { email: "a@test.com", Name: "Alice", "post code": "EC1V", City: "London", Industry: "Tech", Revenue: "50k" },
    };
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtable([record]) as any);
    const pinecone = makePinecone(new Map(), null, ["r1"]);
    vi.mocked(createPineconeClient).mockReturnValue(pinecone as any);

    const ctx = makeCtx();
    await runPineconeSync("London", ctx);

    // No orphan-delete call (the only deleteByIds calls would be for cancelled records, which there are none)
    expect(pinecone.deleteByIds).not.toHaveBeenCalledWith(expect.arrayContaining(["r-orphan-1"]));
  });

  it("inclusion filter excludes Active+Paid members with a cancellation date", async () => {
    vi.mocked(createAirtableClient).mockReturnValue(makeAirtable([]) as any);
    vi.mocked(createPineconeClient).mockReturnValue(makePinecone() as any);

    const ctx = makeCtx();
    await runPineconeSync("London", ctx);

    const listRecordsMock = vi.mocked(createAirtableClient).mock.results[0]!.value.listRecords;
    const formulasUsed = listRecordsMock.mock.calls.map((c: any[]) => c[1]?.filterByFormula).filter(Boolean);
    // At least one of the active-fetching formulas must require Cancellation date = ""
    expect(formulasUsed.some((f: string) => f.includes('{Cancellation date} = ""'))).toBe(true);
  });

  it("returns failure when credentials missing", async () => {
    delete process.env.OPENAI_API_KEY;
    const ctx = makeCtx();
    const result = await runPineconeSync("London", ctx);
    expect(result.success).toBe(false);
    expect(result.summary).toContain("OPENAI_API_KEY");
  });
});
