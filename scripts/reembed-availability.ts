/**
 * One-time, focused re-embed: members who have Availability and/or Topics to
 * Discuss in Airtable. Reuses the nearbyLocation already stored in Pinecone —
 * makes ZERO Google geocode/places calls — and re-embeds via OpenAI in
 * batches (embedTexts already batches at 100). Upserts back to Pinecone.
 *
 * Members not yet in Pinecone are skipped (the normal "Sync to Pinecone" run
 * will geocode + embed them). Safe to re-run: idempotent upserts.
 *
 * Usage: npx tsx scripts/reembed-availability.ts [--dry]
 */
import { createAirtableClient } from "../src/lib/integrations/airtable";
import { createPineconeClient } from "../src/lib/integrations/pinecone";
import { embedTexts } from "../src/lib/integrations/openai-embeddings";
import { toBusinessStage, hasBusinessDomain, buildEmbeddingText } from "../src/lib/matching/transforms";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.development.local" });

const DRY = process.argv.includes("--dry");

async function main() {
  const airtable = createAirtableClient({
    apiKey: process.env.AIRTABLE_GET_DATA_TOKEN!,
    baseId: process.env.AIRTABLE_BASE_ID!,
  });
  const pinecone = createPineconeClient({
    apiKey: process.env.PINECONE_API_KEY!,
    indexName: process.env.PINECONE_INDEX_NAME!,
  });

  const filter = `AND({Membership} = "Active", {Payment} = "Paid", {Cancellation date} = "", OR({Availability} != "", {Topics to Discuss} != ""))`;
  console.log("Fetching active members with Availability/Topics...");
  const records = await airtable.listRecords("Members", { filterByFormula: filter });
  console.log(`Found ${records.length} member(s) with availability/topics data`);
  if (records.length === 0) return;

  const ids = records.map((r) => r.id);
  const existingMeta = await pinecone.fetchMetadataByIds(ids);
  console.log(`${existingMeta.size}/${ids.length} are already in Pinecone (the rest will be handled by a normal sync)`);

  const enriched: Array<{ id: string; embeddingText: string; metadata: Record<string, string | number | boolean> }> = [];
  let skipped = 0;

  for (const record of records) {
    const existing = existingMeta.get(record.id);
    if (!existing) {
      skipped++;
      continue;
    }
    const f = record.fields;
    const email = String(f["email"] || "");
    if (!email) continue;

    const industry = String(f["Industry"] || "");
    const traction = String(f["Revenue"] || "");
    const availability = String(f["Availability"] || "");
    const topics = String(f["Topics to Discuss"] || "");
    const nearbyLocation = String(existing.nearbyLocation || ""); // reuse — NO Google
    const businessStage = toBusinessStage(traction);

    const embeddingText = buildEmbeddingText({ nearbyLocation, businessStage, industry, topics, availability });

    enriched.push({
      id: record.id,
      embeddingText,
      metadata: {
        email,
        name: String(f["Name"] || `${f["First Name"] || ""} ${f["Last Name"] || ""}`).trim(),
        postcode: String(existing.postcode || ""),
        city: String(existing.city || ""),
        nearbyLocation,
        active: true,
        industry,
        traction,
        hasBusinessDomain: hasBusinessDomain(email),
        businessStage,
        availability,
        topics,
      },
    });
  }

  console.log(`Prepared ${enriched.length} re-embed(s), skipped ${skipped} not-yet-in-Pinecone.`);
  if (DRY) {
    console.log("--dry: not embedding or upserting. Sample embedding text:");
    console.log("  ", enriched[0]?.embeddingText);
    return;
  }
  if (enriched.length === 0) return;

  console.log("Generating embeddings (batched)...");
  const embeddings = await embedTexts(enriched.map((e) => e.embeddingText));
  const vectors = enriched.map((e, i) => ({ id: e.id, values: embeddings[i], metadata: e.metadata }));

  console.log("Upserting to Pinecone (batched)...");
  const n = await pinecone.upsertVectors(vectors);
  console.log(`Done — re-embedded ${n} member(s) with availability/topics. Zero Google calls.`);
}

main();
