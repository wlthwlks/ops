/**
 * Find nearby places using Google Places API (New).
 * Queries in 3 distance tiers: 5km, 10km, 25km (40km).
 * Returns places ordered by proximity — closest areas first.
 * Deduplicates across tiers, preserving Google's relevance ordering.
 * Works globally.
 */

// Only successful (non-empty) results are cached. We don't cache empties so a
// transient outage doesn't poison the cache for the whole process lifetime.
const NEARBY_CACHE = new Map<string, string>();

interface PlaceResult {
  displayName?: { text: string };
}

export interface NearbyOptions {
  /** Called with a human-readable error string when an upstream Google call fails. */
  onError?: (msg: string) => void;
}

const RETRY_BACKOFF_MS = [1_000, 3_000, 8_000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function searchNearby(
  lat: number,
  lon: number,
  types: string[],
  radiusMeters: number,
  apiKey: string,
  maxResults: number = 20,
  onError?: (msg: string) => void,
  attempt = 0
): Promise<string[]> {
  const body = {
    includedTypes: types,
    rankPreference: "DISTANCE",
    locationRestriction: {
      circle: {
        center: { latitude: lat, longitude: lon },
        radius: radiusMeters,
      },
    },
    maxResultCount: maxResults,
  };

  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.displayName",
      },
      body: JSON.stringify(body),
    });

    // Retry the per-minute-quota case with exponential backoff. Anything else
    // is fatal for this call — we don't want to retry permission-denied / bad-request.
    if (res.status === 429 && attempt < RETRY_BACKOFF_MS.length) {
      const wait = RETRY_BACKOFF_MS[attempt];
      onError?.(`Places API 429 rate-limited — sleeping ${wait}ms (attempt ${attempt + 1}/${RETRY_BACKOFF_MS.length})`);
      await sleep(wait);
      return searchNearby(lat, lon, types, radiusMeters, apiKey, maxResults, onError, attempt + 1);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const msg = `Places API ${res.status} ${res.statusText}: ${text.slice(0, 250)}`;
      console.error(`[findNearbyPlaces] ${msg}`);
      onError?.(msg);
      return [];
    }

    const data = await res.json();
    return ((data.places ?? []) as PlaceResult[])
      .map((p) => p.displayName?.text ?? "")
      .filter((name) => name.length > 1);
  } catch (err) {
    const msg = `Places API exception: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[findNearbyPlaces] ${msg}`);
    onError?.(msg);
    return [];
  }
}

async function fetchTier(
  lat: number,
  lon: number,
  radiusMeters: number,
  apiKey: string,
  onError?: (msg: string) => void
): Promise<string[]> {
  const stationRadius = Math.min(radiusMeters, 16_000);

  // Serial instead of parallel to keep the per-minute quota happy. Per-tier
  // wall-clock goes up by ~2x but average throughput stays well under
  // Google's `SearchNearbyRequest per minute` limit.
  const stations = await searchNearby(lat, lon, ["train_station", "subway_station", "transit_station", "light_rail_station"], stationRadius, apiKey, 20, onError);
  const landmarks = await searchNearby(lat, lon, ["park", "library", "shopping_mall"], radiusMeters, apiKey, 15, onError);
  const areas = await searchNearby(lat, lon, ["university", "community_center"], radiusMeters, apiKey, 10, onError);

  const lists = [stations, landmarks, areas];
  const seen = new Set<string>();
  const result: string[] = [];
  const maxLen = Math.max(...lists.map((l) => l.length));

  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      if (i < list.length) {
        const name = list[i];
        if (!seen.has(name)) {
          seen.add(name);
          result.push(name);
        }
      }
    }
  }

  return result;
}

export async function findNearbyPlaces(
  lat: number,
  lon: number,
  options?: NearbyOptions
): Promise<string> {
  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = NEARBY_CACHE.get(cacheKey);
  if (cached) return cached; // only return cache when it has content

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    options?.onError?.("GOOGLE_MAPS_API_KEY env var is missing");
    return "";
  }

  const globalSeen = new Set<string>();
  const tiers: string[][] = [];

  for (const radius of [5_000, 10_000, 40_000]) {
    const names = await fetchTier(lat, lon, radius, apiKey, options?.onError);
    const newInTier = names.filter((n) => !globalSeen.has(n));
    newInTier.forEach((n) => globalSeen.add(n));
    if (newInTier.length > 0) {
      tiers.push(newInTier);
    }
  }

  const result = tiers.map((t) => t.join(", ")).join(" | ");
  if (result) NEARBY_CACHE.set(cacheKey, result);
  return result;
}
