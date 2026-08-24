import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  syncMemberSemanticProfile,
  type MemberProfileSyncDeps,
} from "@/lib/introduction/member-profile-sync";
import {
  computeProfileHash,
  semanticFieldsFromRecord,
} from "@/lib/introduction/semantic-profile";
import { introductionMemberProfiles } from "@/db/schema";
import type { AirtableRecord } from "@/lib/integrations/airtable";
import type { PineconeClient } from "@/lib/integrations/pinecone";

vi.mock("@/lib/integrations/openai-embeddings", () => ({
  embedTexts: vi.fn(async (texts: string[]) => texts.map((t) => [t.length, 1, 2])),
  embedText: vi.fn(),
  DIMENSIONS: 1536,
}));

const { embedTexts } = await import("@/lib/integrations/openai-embeddings");

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

const pineconeUpsert = vi.fn();
const pineconeDelete = vi.fn();
const logs: string[] = [];

function makeDeps(): MemberProfileSyncDeps {
  return {
    pinecone: {
      upsertVectors: pineconeUpsert,
      deleteByIds: pineconeDelete,
    } as unknown as PineconeClient,
    db,
    log: (message) => logs.push(message),
  };
}

function member(id: string, fields: Record<string, unknown>): AirtableRecord {
  return { id, fields };
}

const alice = member("rec_alice1234567", {
  email: "alice@example.com",
  City: "London",
  Name: "Alice Founder",
  "Professional Headline": "Founder of a wellness app",
  "Profile Bio": "Love building healthy communities",
  "Current 90-day goal": "Reach 500 paying members",
  "Help wanted": ["FUNDRAISING"],
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
  pineconeUpsert.mockImplementation(async (vectors: unknown[]) => (vectors as unknown[]).length);
  pineconeDelete.mockResolvedValue(undefined);
});

describe("syncMemberSemanticProfile", () => {
  it("embeds non-empty kinds, upserts vectors and records the ledger row", async () => {
    const result = await syncMemberSemanticProfile(alice, makeDeps());

    expect(result.status).toBe("embedded");
    expect(result.vectorsUpserted).toBe(3);
    expect(result.vectorsDeleted).toBe(1);

    const [vectors, namespace] = pineconeUpsert.mock.calls[0];
    expect(namespace).toBe("intro_v2");
    expect(vectors.map((v: { id: string }) => v.id).sort()).toEqual(
      ["profile", "help", "goal"].map((k) => `rec_alice1234567:${k}`).sort()
    );
    const profileVector = vectors.find((v: { id: string }) => v.id === "rec_alice1234567:profile");
    expect(profileVector.metadata).toMatchObject({
      email: "alice@example.com",
      airtableRecordId: "rec_alice1234567",
      kind: "profile",
    });

    const [deletedIds, deletedNamespace] = pineconeDelete.mock.calls[0];
    expect(deletedIds).toEqual(["rec_alice1234567:expertise"]);
    expect(deletedNamespace).toBe("intro_v2");

    const rows = await db.select().from(introductionMemberProfiles);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("synced");
    expect(rows[0].profileHash).toBe(computeProfileHash(semanticFieldsFromRecord(alice)));
    expect(rows[0].lastSyncedAt).not.toBeNull();
  });

  it("embeds a name-based fallback vector for a member with zero semantic content", async () => {
    const blank = member("rec_blank1234567", {
      email: "blank@example.com",
      City: "London",
      Name: "Blank Slate",
    });

    const result = await syncMemberSemanticProfile(blank, makeDeps());
    expect(result.status).toBe("embedded");
    expect(result.vectorsUpserted).toBe(1);

    const texts = vi.mocked(embedTexts).mock.calls[0][0] as string[];
    expect(texts).toEqual(["Member profile: Blank Slate"]);

    const [vectors] = pineconeUpsert.mock.calls[0];
    expect(vectors.map((v: { id: string }) => v.id)).toEqual(["rec_blank1234567:profile"]);
  });

  it("skips as no-op when the ledger hash matches and status is synced", async () => {
    await syncMemberSemanticProfile(alice, makeDeps());
    const firstUpserts = pineconeUpsert.mock.calls.length;

    const second = await syncMemberSemanticProfile(alice, makeDeps());
    expect(second.status).toBe("noop");
    expect(second.vectorsUpserted).toBe(0);
    expect(pineconeUpsert.mock.calls.length).toBe(firstUpserts);
  });

  it("returns no_email for records without an email", async () => {
    const result = await syncMemberSemanticProfile(
      member("rec_noemail12345", { City: "London" }),
      makeDeps()
    );
    expect(result.status).toBe("no_email");
    expect(embedTexts).not.toHaveBeenCalled();
    expect(pineconeUpsert).not.toHaveBeenCalled();
  });

  it("retries members whose ledger row is stuck in error status", async () => {
    vi.mocked(embedTexts).mockRejectedValueOnce(new Error("openai down"));
    const failed = await syncMemberSemanticProfile(alice, makeDeps());
    expect(failed.status).toBe("error");

    const rows = await db.select().from(introductionMemberProfiles);
    expect(rows[0].status).toBe("error");

    const retry = await syncMemberSemanticProfile(alice, makeDeps());
    expect(retry.status).toBe("embedded");

    const after = await db.select().from(introductionMemberProfiles);
    expect(after[0].status).toBe("synced");
  });

  it("never throws when pinecone or the ledger fails", async () => {
    pineconeUpsert.mockRejectedValue(new Error("pinecone down"));
    const result = await syncMemberSemanticProfile(alice, makeDeps());
    expect(result.status).toBe("error");
    expect(result.message).toContain("pinecone down");

    const rows = await db.select().from(introductionMemberProfiles);
    expect(rows[0].status).toBe("error");
    expect(rows[0].lastError).toContain("pinecone down");
  });

  it("returns config_missing when deps are not provided and env is absent", async () => {
    const result = await syncMemberSemanticProfile(alice, null);
    expect(result.status).toBe("config_missing");
  });
});
