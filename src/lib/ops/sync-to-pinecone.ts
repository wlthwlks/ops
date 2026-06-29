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
  // Active + Paid + NOT cancelled. A cancellation date overrides the Active flag.
  return `AND({Membership} = "Active", {Payment} = "Paid", {Cancellation date} = "", OR(${conditions.join(", ")}))`;
}

function buildAllCitiesFilter(): string {
  return `AND({Membership} = "Active", {Payment} = "Paid", {Cancellation date} = "")`;
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

function normalizeLocationField(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
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
  availability: string;
  topics: string;
  embeddingText: string;
}

/**
 * Enrich a single Airtable record. Returns null if no email.
 *
 * `fallbackNearby` is the value already stored in Pinecone for this member.
 * If the new geocode/places lookup yields an empty string (rate limit, API
 * key missing, no places found, transient error) we fall back to it rather
 * than wiping good data.
 *
 * `reuseLocation` — when true (the re-embed was triggered by a non-location
 * change such as Availability/Topics), we reuse the stored `fallbackNearby`
 * and SKIP the Google geocode/places calls entirely. Location is only ever
 * geocoded when it's genuinely new or has moved.
 */
async function enrichMember(
  record: AirtableRecord,
  geocodeCache: Map<string, string>,
  ctx: OpContext,
  fallbackNearby = "",
  reuseLocation = false
): Promise<EnrichedMember | null> {
  const f = record.fields;
  const email = String(f["email"] || "");
  if (!email) return null;

  const postcode = String(f["post code"] || "");
  const city = String(f["City"] || "");
  const industry = String(f["Industry"] || "");
  const traction = String(f["Revenue"] || "");
  const availability = String(f["Availability"] || "");
  const topics = String(f["Topics to Discuss"] || "");

  const businessStage = toBusinessStage(traction);
  const hasBizDomain = hasBusinessDomain(email);

  let nearbyLocation = "";
  if (reuseLocation && fallbackNearby) {
    // Re-embed driven by Availability/Topics, not location — reuse what's
    // already in Pinecone and make zero Google calls.
    nearbyLocation = fallbackNearby;
  } else if (postcode) {
    const outcode = extractOutcode(postcode);
    const cachedNearby = geocodeCache.get(outcode);
    if (cachedNearby !== undefined) {
      nearbyLocation = cachedNearby;
    } else {
      const onError = (msg: string) => {
        // Surface upstream Google errors verbatim into the op log so the
        // operator can see exactly why a member's nearbyLocation came back
        // empty (Places API disabled, billing, key restriction, etc.).
        void ctx.log(`  Google API: ${msg}`);
      };
      const point = await geocode(postcode, city, { onError });
      if (point) {
        nearbyLocation = await findNearbyPlaces(point.lat, point.lon, { onError });
        // Only cache populated results; empties shouldn't poison this run.
        if (nearbyLocation) {
          geocodeCache.set(outcode, nearbyLocation);
          ctx.log(`Geocoded ${outcode}: ${nearbyLocation.slice(0, 60)}...`);
        } else {
          ctx.log(`Geocoded ${outcode} but Places returned 0 results`);
        }
      } else {
        ctx.log(`Could not geocode: ${postcode}`);
      }
    }
  }

  // Defensive: never overwrite a previously populated nearbyLocation with "".
  // If geocoding/places failed this run, keep whatever was already stored.
  if (!nearbyLocation && fallbackNearby) {
    nearbyLocation = fallbackNearby;
    ctx.log(`  preserved existing nearbyLocation for ${email} (new lookup empty)`);
  }

  const embeddingText = buildEmbeddingText({
    nearbyLocation,
    businessStage,
    industry,
    topics,
    availability,
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
    availability,
    topics,
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

  // ─── Step 1: Remove cancelled members (Airtable says cancelled) ───
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

  // ─── Step 1b: Reconcile — delete Pinecone records that aren't in the
  // current Active+Paid+No-cancel set across ALL cities. Catches: hard
  // deletes from Airtable, members who became Paused/Failed without a
  // cancellation date, status flips, and anything else the cancellation
  // sweep above can't see.
  ctx.log("Reconciling Pinecone against Airtable Active+Paid+No-cancel set...");
  const [pineconeIds, activeAirtableRecords] = await Promise.all([
    pinecone.listAllIds(),
    airtable.listRecords("Members", {
      filterByFormula: buildAllCitiesFilter(),
      fields: ["email"],
    }),
  ]);
  const activeIdSet = new Set(activeAirtableRecords.map((r) => r.id));
  const orphanIds = pineconeIds.filter((id) => !activeIdSet.has(id));
  let orphanRemovedCount = 0;
  if (orphanIds.length > 0) {
    ctx.log(`Found ${orphanIds.length} orphan(s) in Pinecone (not Active+Paid in Airtable). Deleting...`);
    await pinecone.deleteByIds(orphanIds);
    orphanRemovedCount = orphanIds.length;
  } else {
    ctx.log(`No orphans — Pinecone has ${pineconeIds.length} records, all match Airtable Active+Paid set.`);
  }
  removedCount += orphanRemovedCount;

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
  // `reuseLocation` rides along with each re-embed record: true means the
  // re-embed was triggered by a non-location change (Availability/Topics)
  // so enrichMember reuses the stored nearbyLocation and skips Google.
  const needsReEmbed: Array<{ record: AirtableRecord; reuseLocation: boolean }> = [];
  const metadataOnly: AirtableRecord[] = [];    // exists, vector unchanged → update metadata, keep vector
  const unchanged: string[] = [];               // for logging

  for (const record of allActiveRecords) {
    const existing = existingMeta.get(record.id);
    if (!existing) {
      // New member — not in Pinecone yet. Geocode from scratch.
      needsReEmbed.push({ record, reuseLocation: false });
      continue;
    }

    const currentCity = normalizeLocationField(String(record.fields["City"] || ""));
    const currentPostcode = normalizeLocationField(String(record.fields["post code"] || ""));
    const existingCity = normalizeLocationField(String(existing.city || ""));
    const existingPostcode = normalizeLocationField(String(existing.postcode || ""));

    const existingNearby = String(existing.nearbyLocation || "");

    // Availability/Topics feed the embedding vector, so a change there means
    // re-embed — but the location is unchanged, so reuse it (no Google).
    const currentAvailability = String(record.fields["Availability"] || "");
    const currentTopics = String(record.fields["Topics to Discuss"] || "");
    const existingAvailability = String(existing.availability || "");
    const existingTopics = String(existing.topics || "");
    const vectorTextChanged =
      currentAvailability !== existingAvailability || currentTopics !== existingTopics;

    if (currentCity !== existingCity || currentPostcode !== existingPostcode || !existingNearby) {
      // Location changed or nearbyLocation missing — needs geocoding + new embedding
      needsReEmbed.push({ record, reuseLocation: false });
    } else if (vectorTextChanged) {
      // Availability/Topics changed — re-embed but reuse the stored location.
      needsReEmbed.push({ record, reuseLocation: true });
    } else {
      // Vector unchanged — check if other (non-vector) metadata changed
      const currentIndustry = String(record.fields["Industry"] || "");
      const currentTraction = String(record.fields["Revenue"] || "");
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

    for (const { record, reuseLocation } of needsReEmbed) {
      // Pass the existing nearbyLocation (if any) as fallback so an empty
      // new lookup never wipes good data already in Pinecone. When
      // reuseLocation is set we use it directly and skip Google.
      const fallbackNearby = String(existingMeta.get(record.id)?.nearbyLocation || "");
      const member = await enrichMember(record, geocodeCache, ctx, fallbackNearby, reuseLocation);
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
          availability: member.availability,
          topics: member.topics,
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
      const traction = String(f["Revenue"] || "");

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
          availability: String(f["Availability"] || ""),
          topics: String(f["Topics to Discuss"] || ""),
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
    // One-click run from the /ops dashboard processes every city. Per-city
    // sync is still available via the /get-matched UI dropdown.
    return runPineconeSync("All Cities", ctx);
  },
};
