import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  runIntroProfileSync,
  DEFAULT_SEMANTIC_NAMESPACE,
  type IntroSyncDeps,
} from "@/lib/ops/sync-intro-profiles";
import {
  computeProfileHash,
  semanticFieldsFromRecord,
  vectorIdFor,
} from "@/lib/introduction/semantic-profile";
import { introductionMemberProfiles } from "@/db/schema";
import type { AirtableClient } from "@/lib/integrations/airtable";
import type { PineconeClient } from "@/lib/integrations/pinecone";

vi.mock("@/lib/integrations/openai-embeddings", () => ({
  embedTexts: vi.fn(async (texts: string[]) => texts.map((t) => [t.length, 1, 2])),
  embedText: vi.fn(),
  DIMENSIONS: 1536,
}));

const { embedTexts } = await import("@/lib/integrations/openai-embeddings");

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

const airtableList = vi.fn();
const pineconeUpsert = vi.fn();
const pineconeDelete = vi.fn();
const pineconeList = vi.fn();
const logs: string[] = [];

function makeDeps(): IntroSyncDeps {
  return {
    airtable: { listRecords: airtableList } as unknown as AirtableClient,
    pinecone: {
      upsertVectors: pineconeUpsert,
      deleteByIds: pineconeDelete,
      listAllIds: pineconeList,
    } as unknown as PineconeClient,
    db,
    log: (message) => logs.push(message),
  };
}

function memberRecord(id: string, fields: Record<string, unknown>) {
  return { id, fields };
}

const alice = memberRecord("rec_alice1234567", {
  email: "alice@example.com",
  City: "London",
  "Professional Headline": "Founder of a wellness app",
  "Profile Bio": "Love building healthy communities",
  "Business description": "A marketplace for coaches",
  "Current 90-day goal": "Reach 500 paying members",
  "Help wanted": ["FUNDRAISING"],
  "Help wanted context": "Pre-seed round in progress",
  Expertise: ["GROWTH_MARKETING"],
  "Expertise context": "Ten years in B2B SaaS",
  "Connection type": "SIMILAR_STAGE_PEER",
});

beforeAll(async () => {
  const test = await createTestDb({ introductionsV2: true });
  db = test.db;
  close = test.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  logs.length = 0;
  await resetIntroductionsV2Tables(db);
  airtableList.mockResolvedValue([]);
  pineconeUpsert.mockImplementation(async (vectors: unknown[]) => (vectors as unknown[]).length);
  pineconeDelete.mockResolvedValue(undefined);
  pineconeList.mockResolvedValue([]);
});

describe("runIntroProfileSync — embedding", () => {
  it("embeds four vectors per new member into the semantic namespace", async () => {
    airtableList.mockResolvedValue([alice]);

    const result = await runIntroProfileSync(makeDeps(), {});

    expect(result.success).toBe(true);
    expect(result.embedded).toBe(1);
    expect(result.vectorsUpserted).toBe(4);
    expect(result.namespace).toBe(DEFAULT_SEMANTIC_NAMESPACE);

    expect(embedTexts).toHaveBeenCalledTimes(1);
    const texts = vi.mocked(embedTexts).mock.calls[0][0] as string[];
    expect(texts).toHaveLength(4);
    expect(texts[0]).toContain("Founder of a wellness app");
    expect(texts[1]).toContain("FUNDRAISING");
    expect(texts[2]).toContain("GROWTH_MARKETING");
    expect(texts[3]).toContain("Reach 500 paying members");

    expect(pineconeUpsert).toHaveBeenCalledTimes(1);
    const [vectors, namespace] = pineconeUpsert.mock.calls[0];
    expect(namespace).toBe(DEFAULT_SEMANTIC_NAMESPACE);
    expect(vectors.map((v: { id: string }) => v.id).sort()).toEqual(
      ["profile", "help", "expertise", "goal"].map((k) => `rec_alice1234567:${k}`).sort()
    );
    const profileVector = vectors.find((v: { id: string }) => v.id === "rec_alice1234567:profile");
    expect(profileVector.metadata).toMatchObject({
      email: "alice@example.com",
      airtableRecordId: "rec_alice1234567",
      kind: "profile",
    });
  });

  it("persists the profile ledger with the computed hash", async () => {
    airtableList.mockResolvedValue([alice]);
    await runIntroProfileSync(makeDeps(), {});

    const rows = await db.select().from(introductionMemberProfiles);
    expect(rows).toHaveLength(1);
    expect(rows[0].airtableRecordId).toBe("rec_alice1234567");
    expect(rows[0].status).toBe("synced");
    expect(rows[0].profileHash).toBe(computeProfileHash(semanticFieldsFromRecord(alice)));
    expect(rows[0].lastSyncedAt).not.toBeNull();
  });

  it("skips members whose profile hash is unchanged", async () => {
    airtableList.mockResolvedValue([alice]);
    await runIntroProfileSync(makeDeps(), {});
    const firstEmbedCalls = vi.mocked(embedTexts).mock.calls.length;

    const second = await runIntroProfileSync(makeDeps(), {});
    expect(second.embedded).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(vi.mocked(embedTexts).mock.calls.length).toBe(firstEmbedCalls);
    expect(pineconeUpsert).toHaveBeenCalledTimes(1);
  });

  it("re-embeds when the semantic profile changed", async () => {
    airtableList.mockResolvedValue([alice]);
    await runIntroProfileSync(makeDeps(), {});

    const changed = memberRecord("rec_alice1234567", {
      ...alice.fields,
      "Current 90-day goal": "Pivot to enterprise sales",
    });
    airtableList.mockResolvedValue([changed]);

    const result = await runIntroProfileSync(makeDeps(), {});
    expect(result.embedded).toBe(1);
    expect(pineconeUpsert).toHaveBeenCalledTimes(2);
  });

  it("embeds a name-based fallback vector for members with no semantic content", async () => {
    const blank = memberRecord("rec_blank1234567", {
      email: "blank@example.com",
      City: "London",
      Name: "Blank Slate",
    });
    const noEmail = memberRecord("rec_noemail12345", { City: "London", "Profile Bio": "Bio" });
    airtableList.mockResolvedValue([blank, noEmail]);

    const result = await runIntroProfileSync(makeDeps(), {});
    expect(result.success).toBe(true);
    expect(result.embedded).toBe(1);
    expect(result.skipped).toBe(1);
    expect(embedTexts).toHaveBeenCalledTimes(1);
    const texts = vi.mocked(embedTexts).mock.calls[0][0] as string[];
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("Member profile: Blank Slate");

    const [vectors] = pineconeUpsert.mock.calls[0];
    expect(vectors.map((v: { id: string }) => v.id)).toEqual(["rec_blank1234567:profile"]);

    const rows = await db.select().from(introductionMemberProfiles);
    expect(rows).toHaveLength(1);
    expect(rows[0].airtableRecordId).toBe("rec_blank1234567");
    expect(rows[0].status).toBe("synced");
  });

  it("marks ledger rows as error when embedding fails", async () => {
    airtableList.mockResolvedValue([alice]);
    vi.mocked(embedTexts).mockRejectedValueOnce(new Error("openai down"));

    const result = await runIntroProfileSync(makeDeps(), {});
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("openai down");

    const rows = await db.select().from(introductionMemberProfiles);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("error");
    expect(rows[0].lastError).toContain("openai down");
  });

  it("retries members whose ledger rows are stuck in error status", async () => {
    airtableList.mockResolvedValue([alice]);
    vi.mocked(embedTexts).mockRejectedValueOnce(new Error("openai down"));
    await runIntroProfileSync(makeDeps(), {});

    const failed = await db.select().from(introductionMemberProfiles);
    expect(failed).toHaveLength(1);
    expect(failed[0].status).toBe("error");

    const second = await runIntroProfileSync(makeDeps(), {});
    expect(second.success).toBe(true);
    expect(second.embedded).toBe(1);

    const rows = await db.select().from(introductionMemberProfiles);
    expect(rows[0].status).toBe("synced");
    expect(rows[0].profileHash).toBe(computeProfileHash(semanticFieldsFromRecord(alice)));
  });

  it("deletes vectors for kinds whose content was cleared", async () => {
    airtableList.mockResolvedValue([alice]);
    await runIntroProfileSync(makeDeps(), {});
    expect(pineconeDelete).not.toHaveBeenCalled();

    const cleared = memberRecord("rec_alice1234567", {
      ...alice.fields,
      "Help wanted": [],
      "Help wanted context": "",
    });
    airtableList.mockResolvedValue([cleared]);

    const result = await runIntroProfileSync(makeDeps(), {});
    expect(result.success).toBe(true);
    expect(result.embedded).toBe(1);
    expect(pineconeDelete).toHaveBeenCalledTimes(1);
    const [ids, namespace] = pineconeDelete.mock.calls[0];
    expect(ids).toEqual(["rec_alice1234567:help"]);
    expect(namespace).toBe(DEFAULT_SEMANTIC_NAMESPACE);
  });
});

describe("runIntroProfileSync — dry run", () => {
  it("performs no writes and reports what would change", async () => {
    airtableList.mockResolvedValue([alice]);

    const result = await runIntroProfileSync(makeDeps(), { dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.success).toBe(true);
    expect(result.embedded).toBe(0);
    expect(result.fetched).toBe(1);
    expect(embedTexts).not.toHaveBeenCalled();
    expect(pineconeUpsert).not.toHaveBeenCalled();
    expect(pineconeDelete).not.toHaveBeenCalled();

    const rows = await db.select().from(introductionMemberProfiles);
    expect(rows).toHaveLength(0);
  });
});

describe("runIntroProfileSync — reconciliation", () => {
  it("deletes stale vectors on an all-cities run", async () => {
    airtableList.mockResolvedValue([alice]);
    pineconeList.mockResolvedValue([
      "rec_alice1234567:profile",
      "rec_gone123456789:profile",
      "rec_gone123456789:help",
    ]);

    const result = await runIntroProfileSync(makeDeps(), {});
    expect(result.deletedVectors).toBe(2);
    expect(pineconeDelete).toHaveBeenCalledTimes(1);
    const [ids, namespace] = pineconeDelete.mock.calls[0];
    expect(ids.sort()).toEqual(["rec_gone123456789:help", "rec_gone123456789:profile"]);
    expect(namespace).toBe(DEFAULT_SEMANTIC_NAMESPACE);
  });

  it("keeps vectors for members still present", async () => {
    airtableList.mockResolvedValue([alice]);
    pineconeList.mockResolvedValue(["rec_alice1234567:profile"]);

    const result = await runIntroProfileSync(makeDeps(), {});
    expect(result.deletedVectors).toBe(0);
    expect(pineconeDelete).not.toHaveBeenCalled();
  });

  it("skips reconciliation for city-scoped runs", async () => {
    airtableList.mockResolvedValue([alice]);
    const result = await runIntroProfileSync(makeDeps(), { cityLabel: "London" });
    expect(result.success).toBe(true);
    expect(pineconeList).not.toHaveBeenCalled();
  });
});

describe("runIntroProfileSync — city handling", () => {
  it("rejects an unknown city label", async () => {
    const result = await runIntroProfileSync(makeDeps(), { cityLabel: "Atlantis" });
    expect(result.success).toBe(false);
    expect(result.errors[0]).toContain("Atlantis");
  });

  it("passes the city filter formula to Airtable for city runs", async () => {
    airtableList.mockResolvedValue([alice]);
    await runIntroProfileSync(makeDeps(), { cityLabel: "London" });
    const [, options] = airtableList.mock.calls[0];
    expect(options.filterByFormula).toContain('FIND(LOWER("London")');
  });
});

describe("vectorIdFor integration", () => {
  it("produces the ids the sync upserts", async () => {
    airtableList.mockResolvedValue([alice]);
    await runIntroProfileSync(makeDeps(), {});
    const [vectors] = pineconeUpsert.mock.calls[0];
    const ids = new Set(vectors.map((v: { id: string }) => v.id));
    for (const kind of ["profile", "help", "expertise", "goal"] as const) {
      expect(ids.has(vectorIdFor("rec_alice1234567", kind))).toBe(true);
    }
  });
});
