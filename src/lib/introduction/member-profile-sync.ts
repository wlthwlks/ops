/**
 * Write-behind semantic profile sync for a single member.
 *
 * Called from the payment-confirmation and profile-update hooks so a member's
 * vectors in the semantic Pinecone namespace stay current with Airtable:
 *   - created as soon as the member pays
 *   - re-embedded whenever a semantic profile field changes
 *   - empty-kind vectors are deleted when content is cleared
 *
 * Idempotent (hash-guarded via the introduction_member_profiles ledger) and
 * NEVER throws — a Pinecone/OpenAI failure must never break payment or
 * profile flows. Failures are logged and surfaced through the ledger row
 * (status "error"), which the next run retries.
 */
import { eq, sql } from "drizzle-orm";
import { db, type AppDb } from "@/db";
import { introductionMemberProfiles } from "@/db/schema";
import type { AirtableRecord } from "@/lib/integrations/airtable";
import {
  createPineconeClient,
  type PineconeClient,
  type VectorRecord,
} from "@/lib/integrations/pinecone";
import { embedTexts } from "@/lib/integrations/openai-embeddings";
import { DEFAULT_SEMANTIC_NAMESPACE } from "@/lib/ops/sync-intro-profiles";
import {
  SEMANTIC_KINDS,
  buildSemanticTexts,
  computeProfileHash,
  semanticFieldsFromRecord,
  vectorIdFor,
  type SemanticKind,
} from "@/lib/introduction/semantic-profile";

export interface MemberProfileSyncDeps {
  pinecone: PineconeClient;
  db: AppDb;
  log: (message: string) => void;
}

export type MemberProfileSyncResult = {
  status: "embedded" | "noop" | "no_email" | "config_missing" | "error";
  vectorsUpserted: number;
  vectorsDeleted: number;
  message?: string;
};

export function semanticNamespace(): string {
  return process.env.INTRO_SEMANTIC_NAMESPACE ?? DEFAULT_SEMANTIC_NAMESPACE;
}

function defaultDeps(): MemberProfileSyncDeps | null {
  const pineconeKey = process.env.PINECONE_API_KEY;
  const pineconeIndex = process.env.PINECONE_INDEX_NAME;
  if (!pineconeKey || !pineconeIndex) return null;
  return {
    pinecone: createPineconeClient({ apiKey: pineconeKey, indexName: pineconeIndex }),
    db,
    log: (message) => console.log(`[member-profile-sync] ${message}`),
  };
}

function buildVectors(record: AirtableRecord, jobs: Array<{ kind: SemanticKind; text: string; hash: string; email: string; city: string }>, embeddings: number[][]): VectorRecord[] {
  return jobs.map((job, i) => ({
    id: vectorIdFor(record.id, job.kind),
    values: embeddings[i],
    metadata: {
      email: job.email,
      profileHash: job.hash,
      city: job.city,
      kind: job.kind,
      airtableRecordId: record.id,
    },
  }));
}

/**
 * Embed/refresh a single member's semantic profile vectors in Pinecone.
 * Never throws; returns a status result instead.
 */
export async function syncMemberSemanticProfile(
  record: AirtableRecord,
  deps: MemberProfileSyncDeps | null = defaultDeps()
): Promise<MemberProfileSyncResult> {
  const email = String(record.fields["email"] ?? "").trim().toLowerCase();
  if (!email) {
    return { status: "no_email", vectorsUpserted: 0, vectorsDeleted: 0 };
  }

  const fields = semanticFieldsFromRecord(record);
  const texts = buildSemanticTexts(fields);
  const hash = computeProfileHash(fields);
  const city = String(record.fields["City"] ?? "");
  const namespace = semanticNamespace();

  if (!deps) {
    return {
      status: "config_missing",
      vectorsUpserted: 0,
      vectorsDeleted: 0,
      message: "PINECONE_API_KEY / PINECONE_INDEX_NAME not configured",
    };
  }

  try {
    const rows = await deps.db
      .select()
      .from(introductionMemberProfiles)
      .where(eq(introductionMemberProfiles.airtableRecordId, record.id));
    const stored = rows[0];

    if (stored?.profileHash === hash && stored.status === "synced") {
      return { status: "noop", vectorsUpserted: 0, vectorsDeleted: 0 };
    }

    const kinds: Record<SemanticKind, string> = {
      profile: texts.profileText,
      help: texts.helpText,
      expertise: texts.expertiseText,
      goal: texts.goalText,
    };
    const nonEmptyKinds = SEMANTIC_KINDS.filter((kind) => kinds[kind]);
    const emptyKinds = SEMANTIC_KINDS.filter((kind) => !kinds[kind]);

    const jobs = nonEmptyKinds.map((kind) => ({
      kind,
      text: kinds[kind],
      hash,
      email,
      city,
    }));

    const embeddings = await embedTexts(jobs.map((j) => j.text));
    const vectors = buildVectors(record, jobs, embeddings);

    const vectorsUpserted = await deps.pinecone.upsertVectors(vectors, namespace);

    // Kinds whose content was cleared must not keep stale vectors around.
    let vectorsDeleted = 0;
    if (emptyKinds.length > 0) {
      const staleIds = emptyKinds.map((kind) => vectorIdFor(record.id, kind));
      await deps.pinecone.deleteByIds(staleIds, namespace);
      vectorsDeleted = staleIds.length;
    }

    const now = new Date();
    await deps.db
      .insert(introductionMemberProfiles)
      .values({
        airtableRecordId: record.id,
        email,
        profileHash: hash,
        status: "synced",
        lastError: null,
        lastSyncedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: introductionMemberProfiles.airtableRecordId,
        set: {
          email: sql`excluded.email`,
          profileHash: sql`excluded.profile_hash`,
          status: sql`excluded.status`,
          lastError: sql`excluded.last_error`,
          lastSyncedAt: sql`excluded.last_synced_at`,
          updatedAt: sql`excluded.updated_at`,
        },
      });

    deps.log(`Upserted ${vectorsUpserted} vector(s), deleted ${vectorsDeleted} for ${record.id}`);
    return { status: "embedded", vectorsUpserted, vectorsDeleted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const now = new Date();
      await deps.db
        .insert(introductionMemberProfiles)
        .values({
          airtableRecordId: record.id,
          email,
          profileHash: hash,
          status: "error",
          lastError: message.slice(0, 500),
          lastSyncedAt: null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: introductionMemberProfiles.airtableRecordId,
          set: {
            email: sql`excluded.email`,
            profileHash: sql`excluded.profile_hash`,
            status: sql`excluded.status`,
            lastError: sql`excluded.last_error`,
            lastSyncedAt: sql`excluded.last_synced_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    } catch (ledgerErr) {
      deps.log(`Ledger write failed for ${record.id}: ${ledgerErr instanceof Error ? ledgerErr.message : String(ledgerErr)}`);
    }
    deps.log(`Sync failed for ${record.id}: ${message}`);
    return {
      status: "error",
      vectorsUpserted: 0,
      vectorsDeleted: 0,
      message: message.slice(0, 500),
    };
  }
}
