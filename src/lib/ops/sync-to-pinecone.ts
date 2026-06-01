import type { Op, OpContext } from "../types";
import { createAirtableClient, type AirtableRecord } from "../integrations/airtable";
import { createPineconeClient } from "../integrations/pinecone";
import { embedTexts } from "../integrations/openai-embeddings";
import { geocode, extractOutcode } from "../geo/geocode";
import { findNearbyPlaces } from "../geo/nearby";
import {
  toBusinessStage,
  hasBusinessDomain,
  buildEmbeddingText,
} from "../matching/transforms";
import { CITIES, type CityGroup } from "../constants";

function buildCityFilter(cityGroup: CityGroup): string {
  const allNames = [cityGroup.label, ...cityGroup.alternatives];
  const conditions = allNames.map(
    (name) => `FIND(LOWER("${name}"), LOWER({City}))`
  );
  return `AND({Membership} = "Active", {Payment} = "Paid", OR(${conditions.join(", ")}))`;
}

function buildAllCitiesFilter(): string {
  return `AND({Membership} = "Active", {Payment} = "Paid")`;
}

function buildCancelledFilter(cityGroup: CityGroup): string {
  const allNames = [cityGroup.label, ...cityGroup.alternatives];
  const conditions = allNames.map(
    (name) => `FIND(LOWER("${name}"), LOWER({City}))`
  );
  return `AND({Cancellation date} != "", OR(${conditions.join(", ")}))`;
}

function buildAllCancelledFilter(): string {
  return `{Cancellation date} != ""`;
}

interface EnrichedMember {
  id: string;
  email: string;
  name: string;
  postcode: string;
  city: string;
  nearbyLocation: string;
  active: boolean;
  industry: string;
  traction: string;
  hasBusinessDomain: boolean;
  businessStage: string;
  embeddingText: string;
}

/**
 * Enrich a single Airtable record. Returns null if no email.
 */
async function enrichMember(
  record: AirtableRecord,
  geocodeCache: Map<string, string>,
  ctx: OpContext
): Promise<EnrichedMember | null> {
  const f = record.fields;
  const email = String(f["email"] || "");
  if (!email) return null;

  const postcode = String(f["post code"] || "");
  const city = String(f["City"] || "");
  const industry = String(f["Industry"] || "");
  const traction = String(f["Traction"] || "");

  const businessStage = toBusinessStage(traction);
  const hasBizDomain = hasBusinessDomain(email);

  let nearbyLocation = "";
  if (postcode) {
    const outcode = extractOutcode(postcode);
    const cachedNearby = geocodeCache.get(outcode);
    if (cachedNearby !== undefined) {
      nearbyLocation = cachedNearby;
    } else {
      const point = await geocode(postcode, city);
      if (point) {
        nearbyLocation = await findNearbyPlaces(point.lat, point.lon);
        geocodeCache.set(outcode, nearbyLocation);
        ctx.log(`Geocoded ${outcode}: ${nearbyLocation.slice(0, 60)}...`);
      } else {
        geocodeCache.set(outcode, "");
        ctx.log(`Could not geocode: ${postcode}`);
      }
    }
  }

  const embeddingText = buildEmbeddingText({
    nearbyLocation,
    businessStage,
    industry,
  });

  return {
    id: record.id,
    email,
    name: String(f["Name"] || `${f["First Name"] || ""} ${f["Last Name"] || ""}`).trim(),
    postcode,
    city,
    nearbyLocation,
    active: true,
    industry,
    traction,
    hasBusinessDomain: hasBizDomain,
    businessStage,
    embeddingText,
  };
}

/**
 * Core sync logic — incremental:
 *  1. Remove cancelled members from Pinecone
 *  2. For active members, compare city/postcode against existing Pinecone metadata
 *  3. Only re-embed members that are new or have changed city/postcode
 *  4. Members with unchanged location get metadata-only updates (no re-embed)
 */
export async function runPineconeSync(
  cityLabel: string,
  ctx: OpContext
): Promise<{ success: boolean; summary: string; recordsProcessed?: number }> {
  const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
  const airtableBase = process.env.AIRTABLE_BASE_ID;
  const pineconeKey = process.env.PINECONE_API_KEY;
  const pineconeIndex = process.env.PINECONE_INDEX_NAME;

  if (!airtableToken || !airtableBase) {
    return { success: false, summary: "Missing Airtable credentials" };
  }
  if (!pineconeKey || !pineconeIndex) {
    return { success: false, summary: "Missing Pinecone credentials" };
  }
  if (!process.env.OPENAI_API_KEY) {
    return { success: false, summary: "Missing OPENAI_API_KEY" };
  }

  const airtable = createAirtableClient({ apiKey: airtableToken, baseId: airtableBase });
  const pinecone = createPineconeClient({ apiKey: pineconeKey, indexName: pineconeIndex });

  const isAllCities = cityLabel === "All Cities";
  const cityGroups: CityGroup[] = isAllCities
    ? CITIES
    : CITIES.filter((c) => c.label === cityLabel);

  if (!isAllCities && cityGroups.length === 0) {
    return { success: false, summary: `City "${cityLabel}" not found in CITIES list` };
  }

  // ─── Step 1: Remove cancelled members ───
  ctx.log(`Checking for cancelled members (${isAllCities ? "all cities" : cityLabel})...`);
  const cancelledFilter = isAllCities
    ? buildAllCancelledFilter()
    : buildCancelledFilter(cityGroups[0]);

  const cancelledRecords = await airtable.listRecords("Members", {
    filterByFormula: cancelledFilter,
    fields: ["email", "City", "Cancellation date"],
  });

  let removedCount = 0;
  if (cancelledRecords.length > 0) {
    const cancelledIds = cancelledRecords.map((r) => r.id);
    ctx.log(`Removing ${cancelledIds.length} cancelled member(s) from Pinecone...`);
    await pinecone.deleteByIds(cancelledIds);
    removedCount = cancelledIds.length;
    ctx.log(`Removed ${removedCount} cancelled record(s)`);
  } else {
    ctx.log("No cancelled members to remove");
  }

  // ─── Step 2: Fetch active members from Airtable ───
  let allActiveRecords: AirtableRecord[] = [];

  if (isAllCities) {
    ctx.log("Fetching all active+paid members from Airtable...");
    allActiveRecords = await airtable.listRecords("Members", {
      filterByFormula: buildAllCitiesFilter(),
    });
  } else {
    for (const cityGroup of cityGroups) {
      ctx.log(`Fetching active members for ${cityGroup.label}...`);
      const records = await airtable.listRecords("Members", {
        filterByFormula: buildCityFilter(cityGroup),
      });
      allActiveRecords.push(...records);
    }
  }

  // Filter out any with cancellation date (belt and suspenders)
  allActiveRecords = allActiveRecords.filter((r) => !r.fields["Cancellation date"]);

  ctx.log(`Found ${allActiveRecords.length} active member(s)`);

  if (allActiveRecords.length === 0) {
    return {
      success: true,
      summary: `No active members for ${cityLabel}. Removed ${removedCount} cancelled.`,
      recordsProcessed: 0,
    };
  }

  // ─── Step 3: Fetch existing Pinecone metadata for comparison ───
  const activeIds = allActiveRecords.map((r) => r.id);
  ctx.log(`Fetching existing Pinecone metadata for ${activeIds.length} member(s)...`);
  const existingMeta = await pinecone.fetchMetadataByIds(activeIds);
  ctx.log(`Found ${existingMeta.size} existing record(s) in Pinecone`);

  // ─── Step 4: Classify members into new/changed/unchanged ───
  const needsReEmbed: AirtableRecord[] = [];   // new or city/postcode changed → full re-geocode + embed
  const metadataOnly: AirtableRecord[] = [];    // exists, location unchanged → update metadata, keep vector
  const unchanged: string[] = [];               // for logging

  for (const record of allActiveRecords) {
    const existing = existingMeta.get(record.id);
    if (!existing) {
      // New member — not in Pinecone yet
      needsReEmbed.push(record);
      continue;
    }

    const currentCity = String(record.fields["City"] || "");
    const currentPostcode = String(record.fields["post code"] || "");
    const existingCity = String(existing.city || "");
    const existingPostcode = String(existing.postcode || "");

    if (currentCity !== existingCity || currentPostcode !== existingPostcode) {
      // Location changed — needs new geocoding + new embedding
      needsReEmbed.push(record);
    } else {
      // Location same — check if other metadata changed
      const currentIndustry = String(record.fields["Industry"] || "");
      const currentTraction = String(record.fields["Traction"] || "");
      const existingIndustry = String(existing.industry || "");
      const existingTraction = String(existing.traction || "");

      if (currentIndustry !== existingIndustry || currentTraction !== existingTraction) {
        metadataOnly.push(record);
      } else {
        unchanged.push(record.id);
      }
    }
  }

  ctx.log(`Classification: ${needsReEmbed.length} new/location-changed, ${metadataOnly.length} metadata-only, ${unchanged.length} unchanged`);

  // ─── Step 5: Re-embed members with new/changed locations ───
  const geocodeCache = new Map<string, string>();
  let reEmbedded = 0;

  if (needsReEmbed.length > 0) {
    ctx.log(`Enriching ${needsReEmbed.length} member(s) needing re-embed...`);
    const enriched: EnrichedMember[] = [];

    for (const record of needsReEmbed) {
      const member = await enrichMember(record, geocodeCache, ctx);
      if (member) enriched.push(member);
    }

    if (enriched.length > 0) {
      ctx.log(`Generating ${enriched.length} embedding(s)...`);
      const texts = enriched.map((m) => m.embeddingText);
      const embeddings = await embedTexts(texts);

      const vectors = enriched.map((member, i) => ({
        id: member.id,
        values: embeddings[i],
        metadata: {
          email: member.email,
          name: member.name,
          postcode: member.postcode,
          city: member.city,
          nearbyLocation: member.nearbyLocation,
          active: member.active,
          industry: member.industry,
          traction: member.traction,
          hasBusinessDomain: member.hasBusinessDomain,
          businessStage: member.businessStage,
        },
      }));

      reEmbedded = await pinecone.upsertVectors(vectors);
      ctx.log(`Upserted ${reEmbedded} re-embedded vector(s)`);
    }
  }

  // ─── Step 6: Metadata-only updates (keep existing vector, update metadata) ───
  let metaUpdated = 0;

  if (metadataOnly.length > 0) {
    ctx.log(`Updating metadata for ${metadataOnly.length} member(s) (no re-embed)...`);
    const metaVectors: Array<{
      id: string;
      values: number[];
      metadata: Record<string, string | number | boolean | string[]>;
    }> = [];

    for (const record of metadataOnly) {
      const existing = existingMeta.get(record.id);
      if (!existing) continue;

      // Fetch the existing vector to preserve it
      const existingRecord = await pinecone.fetchById(record.id);
      if (!existingRecord) continue;

      const f = record.fields;
      const email = String(f["email"] || "");
      const industry = String(f["Industry"] || "");
      const traction = String(f["Traction"] || "");

      metaVectors.push({
        id: record.id,
        values: existingRecord.values,
        metadata: {
          email,
          name: String(f["Name"] || `${f["First Name"] || ""} ${f["Last Name"] || ""}`).trim(),
          postcode: String(existing.postcode || ""),
          city: String(existing.city || ""),
          nearbyLocation: String(existing.nearbyLocation || ""),
          active: true,
          industry,
          traction,
          hasBusinessDomain: hasBusinessDomain(email),
          businessStage: toBusinessStage(traction),
        },
      });
    }

    if (metaVectors.length > 0) {
      metaUpdated = await pinecone.upsertVectors(metaVectors);
      ctx.log(`Updated metadata for ${metaUpdated} member(s)`);
    }
  }

  const summary = [
    `${reEmbedded} re-embedded`,
    `${metaUpdated} metadata-updated`,
    `${unchanged.length} unchanged`,
    `${removedCount} cancelled removed`,
  ].join(", ");

  ctx.log(`Sync complete: ${summary}`);

  return {
    success: true,
    summary: `${cityLabel}: ${summary}`,
    recordsProcessed: reEmbedded + metaUpdated,
  };
}

/**
 * Op registered in the ops dashboard — defaults to London for the quick-run button.
 */
export const syncToPinecone: Op = {
  slug: "sync-to-pinecone",
  name: "Sync Members to Pinecone",
  description: "Sync members from Airtable to Pinecone for matching. Use /get-matched page for city selection.",

  run: async (ctx) => {
    return runPineconeSync("London", ctx);
  },
};
