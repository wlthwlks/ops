import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { rejectUnauthorizedCron } from "@/lib/ops/cron-auth";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createPineconeClient } from "@/lib/integrations/pinecone";
import {
  runIntroProfileSync,
  reconcileSemanticNamespace,
  DEFAULT_SEMANTIC_NAMESPACE,
} from "@/lib/ops/sync-intro-profiles";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Hourly self-healing sync for the semantic Pinecone namespace (intro_v2).
 *
 * Runs the FULL profile sync (all cities): embeds missing/changed members
 * (hash-guarded — normally zero OpenAI calls), re-embeds members whose
 * vectors went missing while their ledger said "synced", retries failed
 * ledger rows, and deletes vectors for members no longer in the active set
 * (cancelled, paused, non-Active, deleted). When OPENAI_API_KEY is missing
 * the route degrades to a delete-only reconcile.
 */
export async function POST(request: NextRequest) {
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;

  if (
    process.env.INTRO_PINECONE_CLEANUP_CRON_ENABLED !== "true" &&
    process.env.INTRO_PINECONE_CLEANUP_CRON_ENABLED !== "1"
  ) {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "INTRO_PINECONE_CLEANUP_CRON_ENABLED is not true",
    });
  }

  const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
  const airtableBase = process.env.AIRTABLE_BASE_ID;
  const pineconeKey = process.env.PINECONE_API_KEY;
  const pineconeIndex = process.env.PINECONE_INDEX_NAME;
  const namespace = process.env.INTRO_SEMANTIC_NAMESPACE ?? DEFAULT_SEMANTIC_NAMESPACE;

  if (!airtableToken || !airtableBase) {
    return NextResponse.json({
      success: false,
      error: "Airtable not configured (AIRTABLE_GET_DATA_TOKEN / AIRTABLE_BASE_ID)",
    });
  }
  if (!pineconeKey || !pineconeIndex) {
    return NextResponse.json({
      success: false,
      error: "Pinecone not configured (PINECONE_API_KEY / PINECONE_INDEX_NAME)",
    });
  }

  const deps = {
    airtable: createAirtableClient({ apiKey: airtableToken, baseId: airtableBase }),
    pinecone: createPineconeClient({ apiKey: pineconeKey, indexName: pineconeIndex }),
    db,
    log: (message: string) => console.log(`[pinecone-semantic-cleanup] ${message}`),
  };

  if (!process.env.OPENAI_API_KEY) {
    try {
      const result = await reconcileSemanticNamespace(
        { airtable: deps.airtable, pinecone: deps.pinecone, log: deps.log },
        { namespace }
      );
      return NextResponse.json({
        success: true,
        degraded: true,
        reason: "OPENAI_API_KEY missing — delete-only reconcile",
        namespace,
        deletedVectors: result.deletedVectors,
        namespaceVectorCount: result.namespaceVectorCount,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "pinecone_semantic_cleanup_cron_failed",
          message: err instanceof Error ? err.message : String(err),
        })
      );
      return NextResponse.json(
        { success: false, error: err instanceof Error ? err.message : "Cleanup failed" },
        { status: 500 }
      );
    }
  }

  try {
    const result = await runIntroProfileSync(deps, { cityLabel: "All Cities" });
    return NextResponse.json({
      success: result.success,
      namespace,
      fetched: result.fetched,
      embedded: result.embedded,
      vectorsUpserted: result.vectorsUpserted,
      unchanged: result.unchanged,
      skipped: result.skipped,
      deletedVectors: result.deletedVectors,
      summary: result.summary,
      ...(result.errors.length > 0 ? { errors: result.errors } : {}),
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "pinecone_semantic_cleanup_cron_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    );
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Sync failed" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
