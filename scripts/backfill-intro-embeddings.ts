/**
 * Backfill/refresh the semantic introduction profile embeddings.
 *
 * Idempotent: members whose semantic profile hash is unchanged are skipped,
 * so re-running is cheap. Use --dry-run to see what would change first.
 *
 * Usage:
 *   npx tsx scripts/backfill-intro-embeddings.ts                      (all cities)
 *   npx tsx scripts/backfill-intro-embeddings.ts --city=London
 *   npx tsx scripts/backfill-intro-embeddings.ts --dry-run
 *   npx tsx scripts/backfill-intro-embeddings.ts --city=London --dry-run
 */
import * as dotenv from "dotenv";
import { db } from "@/db";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createPineconeClient } from "@/lib/integrations/pinecone";
import {
  runIntroProfileSync,
  type IntroSyncDeps,
} from "@/lib/ops/sync-intro-profiles";

dotenv.config();

function parseArgs(argv: string[]): { city?: string; dryRun: boolean } {
  const args: { city?: string; dryRun: boolean } = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    const cityMatch = /^--city=(.+)$/.exec(arg);
    if (cityMatch) args.city = cityMatch[1];
  }
  return args;
}

async function main() {
  const { city, dryRun } = parseArgs(process.argv.slice(2));

  const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
  const airtableBase = process.env.AIRTABLE_BASE_ID;
  const pineconeKey = process.env.PINECONE_API_KEY;
  const pineconeIndex = process.env.PINECONE_INDEX_NAME;

  if (!airtableToken || !airtableBase) {
    console.error("Missing AIRTABLE_GET_DATA_TOKEN / AIRTABLE_BASE_ID");
    process.exit(1);
  }
  if (!pineconeKey || !pineconeIndex) {
    console.error("Missing PINECONE_API_KEY / PINECONE_INDEX_NAME");
    process.exit(1);
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error("Missing OPENAI_API_KEY");
    process.exit(1);
  }

  const deps: IntroSyncDeps = {
    airtable: createAirtableClient({ apiKey: airtableToken, baseId: airtableBase }),
    pinecone: createPineconeClient({ apiKey: pineconeKey, indexName: pineconeIndex }),
    db,
    log: (message) => console.log(message),
  };

  const result = await runIntroProfileSync(deps, {
    cityLabel: city ?? "All Cities",
    dryRun,
  });

  console.log("\n=== RESULT ===");
  console.log(JSON.stringify(result, null, 2));

  if (!result.success) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
