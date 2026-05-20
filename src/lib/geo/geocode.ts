/**
 * Geocoding using Google Maps Geocoding API.
 * Works globally with any address, postcode, or city.
 */

export interface GeoPoint {
  lat: number;
  lon: number;
  displayName: string;
}

const GEOCODE_CACHE = new Map<string, GeoPoint | null>();

/**
 * Geocode a postcode + city to lat/lng using Google Maps Geocoding API.
 */
export async function geocode(postcode: string, city: string): Promise<GeoPoint | null> {
  const cacheKey = `${postcode}|${city}`.toLowerCase();
  const cached = GEOCODE_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    // Fallback: return null if no Google API key
    return null;
  }

  const query = postcode ? `${postcode}, ${city}` : city;
  const params = new URLSearchParams({
    address: query,
    key: apiKey,
  });

  const url = `https://maps.googleapis.com/maps/api/geocode/json?${params}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      GEOCODE_CACHE.set(cacheKey, null);
      return null;
    }

    const data = await res.json();
    if (data.status !== "OK" || !data.results?.length) {
      GEOCODE_CACHE.set(cacheKey, null);
      return null;
    }

    const result = data.results[0];
    const point: GeoPoint = {
      lat: result.geometry.location.lat,
      lon: result.geometry.location.lng,
      displayName: result.formatted_address ?? "",
    };

    GEOCODE_CACHE.set(cacheKey, point);
    return point;
  } catch {
    GEOCODE_CACHE.set(cacheKey, null);
    return null;
  }
}

/**
 * Extract the outcode from a postcode (e.g., "SW11 2JP" → "SW11").
 * For non-UK postcodes, returns the full trimmed value.
 */
export function extractOutcode(postcode: string): string {
  const trimmed = postcode.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) return parts[0].toUpperCase();
  return trimmed.toUpperCase();
}
