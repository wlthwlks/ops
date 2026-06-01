import { createAirtableClient } from "../src/lib/integrations/airtable";
import { createPineconeClient } from "../src/lib/integrations/pinecone";
import { embedTexts } from "../src/lib/integrations/openai-embeddings";
import { geocode, extractOutcode } from "../src/lib/geo/geocode";
import { findNearbyPlaces } from "../src/lib/geo/nearby";
import {
  toBusinessStage,
  hasBusinessDomain,
  buildEmbeddingText,
} from "../src/lib/matching/transforms";
import { CITIES } from "../src/lib/constants";

const LONDON = CITIES.find((c) => c.label === "London")!;

async function main() {
  const airtable = createAirtableClient({
    apiKey: process.env.AIRTABLE_GET_DATA_TOKEN!,
    baseId: process.env.AIRTABLE_BASE_ID!,
  });
  const pinecone = createPineconeClient({
    apiKey: process.env.PINECONE_API_KEY!,
    indexName: process.env.PINECONE_INDEX_NAME!,
  });

  // 1. Fetch active London members
  const allNames = [LONDON.label, ...LONDON.alternatives];
  const conditions = allNames.map(
    (name) => `FIND(LOWER("${name}"), LOWER({City}))`
  );
  const filter = `AND({Membership} = "Active", {Payment} = "Paid", OR(${conditions.join(", ")}))`;

  console.log("Fetching active London members...");
  const records = await airtable.listRecords("Members", { filterByFormula: filter });
  console.log(`Found ${records.length} active London members`);

  // 2. Enrich
  console.log("Enriching members...");
  const geocodeCache = new Map<string, string>();
  const enriched: Array<{
    id: string; email: string; name: string; postcode: string; city: string;
    nearbyLocation: string; industry: string; traction: string;
    hasBusinessDomain: boolean;
    businessStage: string; embeddingText: string;
  }> = [];

  for (const record of records) {
    const f = record.fields;
    const email = String(f["email"] || "");
    if (!email) continue;

    const cancellationDate = f["Cancellation date"];
    if (cancellationDate) continue;

    const postcode = String(f["post code"] || "");
    const city = String(f["City"] || "London");
    const industry = String(f["Industry"] || "");
    const traction = String(f["Revenue"] || "");
    const businessStage = toBusinessStage(traction);
    const hasBizDomain = hasBusinessDomain(email);

    let nearbyLocation = "";
    if (postcode) {
      const outcode = extractOutcode(postcode);
      const cached = geocodeCache.get(outcode);
      if (cached !== undefined) {
        nearbyLocation = cached;
      } else {
        const point = await geocode(postcode, city);
        if (point) {
          nearbyLocation = await findNearbyPlaces(point.lat, point.lon);
          geocodeCache.set(outcode, nearbyLocation);
          console.log(`  Geocoded ${outcode} (${nearbyLocation.slice(0, 60)}...)`);
        } else {
          geocodeCache.set(outcode, "");
          console.log(`  Could not geocode: ${postcode}`);
        }
      }
    }

    const embeddingText = buildEmbeddingText({
      nearbyLocation, businessStage, industry,
    });

    enriched.push({
      id: record.id, email,
      name: String(f["Name"] || `${f["First Name"] || ""} ${f["Last Name"] || ""}`).trim(),
      postcode, city, nearbyLocation, industry, traction,
      hasBusinessDomain: hasBizDomain,
      businessStage, embeddingText,
    });
  }

  console.log(`Enriched ${enriched.length} members. Generating embeddings...`);

  // 3. Embed
  const texts = enriched.map((m) => m.embeddingText);
  const embeddings = await embedTexts(texts);
  console.log(`Generated ${embeddings.length} embeddings. Upserting to Pinecone...`);

  // 4. Upsert
  const vectors = enriched.map((member, i) => ({
    id: member.id,
    values: embeddings[i],
    metadata: {
      email: member.email,
      name: member.name,
      postcode: member.postcode,
      city: member.city,
      nearbyLocation: member.nearbyLocation,
      active: true,
      industry: member.industry,
      traction: member.traction,
      hasBusinessDomain: member.hasBusinessDomain,
      businessStage: member.businessStage,
    },
  }));

  const count = await pinecone.upsertVectors(vectors);
  console.log(`Done! Upserted ${count} vectors to Pinecone.`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
