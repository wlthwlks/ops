/**
 * Find nearby places using Google Places API (New).
 * Queries in 3 distance tiers: 5km, 10km, 25km (40km).
 * Returns places ordered by proximity — closest areas first.
 * Deduplicates across tiers, preserving Google's relevance ordering.
 * Works globally.
 */

const NEARBY_CACHE = new Map<string, string>();

interface PlaceResult {
  displayName?: { text: string };
}

/**
 * Single search call — returns names in Google's proximity/relevance order.
 */
async function searchNearby(
  lat: number,
  lon: number,
  types: string[],
  radiusMeters: number,
  apiKey: string,
  maxResults: number = 20
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

    if (!res.ok) return [];

    const data = await res.json();
    return ((data.places ?? []) as PlaceResult[])
      .map((p) => p.displayName?.text ?? "")
      .filter((name) => name.length > 1);
  } catch {
    return [];
  }
}

/**
 * Fetch all place types for a single tier, merge-dedup preserving order.
 * Runs all type searches in parallel, then round-robin interleaves results
 * so no single type dominates the top of the list.
 */
async function fetchTier(
  lat: number,
  lon: number,
  radiusMeters: number,
  apiKey: string
): Promise<string[]> {
  const stationRadius = Math.min(radiusMeters, 16_000);

  const [stations, landmarks, areas] = await Promise.all([
    searchNearby(lat, lon, ["train_station", "subway_station", "transit_station", "light_rail_station"], stationRadius, apiKey, 20),
    searchNearby(lat, lon, ["park", "library", "shopping_mall"], radiusMeters, apiKey, 15),
    searchNearby(lat, lon, ["university", "community_center"], radiusMeters, apiKey, 10),
  ]);

  // Round-robin interleave: take one from each list in turn
  // This preserves per-type proximity order while mixing types fairly
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

/**
 * Find nearby places in 3 tiers: 5km → 10km → 25km.
 * Places are ordered closest-first within each tier.
 * Duplicates across tiers are removed (a place found at 5km won't repeat at 10km).
 * Tiers are separated by " | " for downstream parsing.
 *
 * Example: "Clapham Junction, Battersea, Brixton | Fulham, Chelsea | Croydon, Kingston"
 */
export async function findNearbyPlaces(
  lat: number,
  lon: number
): Promise<string> {
  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = NEARBY_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return "";

  const globalSeen = new Set<string>();
  const tiers: string[][] = [];

  for (const radius of [5_000, 10_000, 40_000]) {
    const names = await fetchTier(lat, lon, radius, apiKey);
    const newInTier = names.filter((n) => !globalSeen.has(n));
    newInTier.forEach((n) => globalSeen.add(n));
    if (newInTier.length > 0) {
      tiers.push(newInTier);
    }
  }

  const result = tiers.map((t) => t.join(", ")).join(" | ");
  NEARBY_CACHE.set(cacheKey, result);
  return result;
}
