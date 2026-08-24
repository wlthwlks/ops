/**
 * Blocking pre-match Pinecone sync.
 *
 * Runs the full semantic profile sync (all cities) immediately before match
 * generation (manual previews and the city scheduler tick) so vectors are
 * guaranteed fresh — missing vectors re-embedded, stale ones deleted — even
 * if a write-behind hook was missed. Hash-guarded, so the steady-state cost
 * is a few Airtable/Pinecone list calls and zero OpenAI embeddings.
 *
 * Callers treat a failed sync as fatal for the match generation step.
 */
import type { AirtableClient } from "@/lib/integrations/airtable";
import type { PineconeClient } from "@/lib/integrations/pinecone";
import type { AppDb } from "@/db";
import { runIntroProfileSync } from "@/lib/ops/sync-intro-profiles";

export interface PreplanSyncDeps {
  airtable: AirtableClient;
  pinecone: PineconeClient;
  db: AppDb;
  log: (message: string) => void;
}

export interface PreplanSyncResult {
  success: boolean;
  summary: string;
}

export async function syncPineconeBeforePlan(
  deps: PreplanSyncDeps
): Promise<PreplanSyncResult> {
  deps.log("Syncing Pinecone before match generation (All Cities)...");
  const result = await runIntroProfileSync(deps, { cityLabel: "All Cities" });
  deps.log(`Pre-plan sync complete: ${result.summary}`);
  return { success: result.success, summary: result.summary };
}
