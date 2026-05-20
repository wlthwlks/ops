import { Pinecone } from "@pinecone-database/pinecone";
import type { RecordMetadata } from "@pinecone-database/pinecone";

export interface PineconeConfig {
  apiKey: string;
  indexName: string;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: RecordMetadata;
}

export interface QueryMatch {
  id: string;
  score: number;
  metadata: RecordMetadata;
}

export function createPineconeClient(config: PineconeConfig) {
  const pc = new Pinecone({ apiKey: config.apiKey });
  const index = pc.index(config.indexName);

  async function upsertVectors(vectors: VectorRecord[]): Promise<number> {
    const BATCH_SIZE = 100;
    let upserted = 0;

    for (let i = 0; i < vectors.length; i += BATCH_SIZE) {
      const batch = vectors.slice(i, i + BATCH_SIZE);
      await index.upsert({ records: batch });
      upserted += batch.length;
    }

    return upserted;
  }

  async function queryByVector(
    vector: number[],
    topK: number,
    filter?: object
  ): Promise<QueryMatch[]> {
    const result = await index.query({
      vector,
      topK,
      filter,
      includeMetadata: true,
    });

    return (result.matches ?? []).map((m) => ({
      id: m.id,
      score: m.score ?? 0,
      metadata: (m.metadata ?? {}) as RecordMetadata,
    }));
  }

  async function fetchById(id: string): Promise<VectorRecord | null> {
    const result = await index.fetch({ ids: [id] });
    const record = result.records?.[id];
    if (!record) return null;

    return {
      id: record.id,
      values: record.values ?? [],
      metadata: (record.metadata ?? {}) as RecordMetadata,
    };
  }

  async function fetchMetadataByIds(ids: string[]): Promise<Map<string, RecordMetadata>> {
    const result = new Map<string, RecordMetadata>();
    const BATCH_SIZE = 100;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const response = await index.fetch({ ids: batch });
      for (const [id, record] of Object.entries(response.records ?? {})) {
        if (record?.metadata) {
          result.set(id, record.metadata as RecordMetadata);
        }
      }
    }
    return result;
  }

  async function deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const BATCH_SIZE = 1000;
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      try {
        await index.deleteMany({ ids: batch });
      } catch {
        // Pinecone returns 404 when IDs don't exist — safe to ignore
      }
    }
  }

  return { upsertVectors, queryByVector, fetchById, fetchMetadataByIds, deleteByIds, pc, index };
}

export type PineconeClient = ReturnType<typeof createPineconeClient>;
