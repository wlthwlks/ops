import { NextRequest, NextResponse } from "next/server";
import { rejectUnauthorizedCron } from "@/lib/ops/cron-auth";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createPineconeClient } from "@/lib/integrations/pinecone";
import {
  reconcileSemanticNamespace,
  DEFAULT_SEMANTIC_NAMESPACE,
} from "@/lib/ops/sync-intro-profiles";

export const runtime = "nodejs";

/**
 * Daily cleanup for the semantic Pinecone namespace (intro_v2).
 *
 * Deletes vectors whose member is no longer Active / was cancelled / is
 * paused / was removed from Airtable. Deletion-only and bounded: one minimal
 * Airtable list (email field only), one Pinecone list walk and batched
 * deletes — no embeddings, no OpenAI calls.
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

  try {
    const result = await reconcileSemanticNamespace(
      {
        airtable: createAirtableClient({ apiKey: airtableToken, baseId: airtableBase }),
        pinecone: createPineconeClient({ apiKey: pineconeKey, indexName: pineconeIndex }),
        log: (message) => console.log(`[pinecone-semantic-cleanup] ${message}`),
      },
      { namespace }
    );

    return NextResponse.json({
      success: true,
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
      {
        success: false,
        error: err instanceof Error ? err.message : "Cleanup failed",
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  return POST(request);
}
