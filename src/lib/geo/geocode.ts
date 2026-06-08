/**
 * Geocoding using Google Maps Geocoding API.
 * Works globally with any address, postcode, or city.
 */

export interface GeoPoint {
  lat: number;
  lon: number;
  displayName: string;
}

export interface GeocodeOptions {
  /** Called with a human-readable error string when the Google call fails. */
  onError?: (msg: string) => void;
}

// Only successful results are cached. We don't cache null/failure so a transient
// outage doesn't suppress retries for the whole process lifetime.
const GEOCODE_CACHE = new Map<string, GeoPoint>();

export async function geocode(
  postcode: string,
  city: string,
  options?: GeocodeOptions
): Promise<GeoPoint | null> {
  const cacheKey = `${postcode}|${city}`.toLowerCase();
  const cached = GEOCODE_CACHE.get(cacheKey);
  if (cached) return cached;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    options?.onError?.("GOOGLE_MAPS_API_KEY env var is missing");
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
      const text = await res.text().catch(() => "");
      const msg = `Geocoding API ${res.status} ${res.statusText}: ${text.slice(0, 250)}`;
      console.error(`[geocode] ${msg}`);
      options?.onError?.(msg);
      return null;
    }

    const data = await res.json();
    if (data.status !== "OK" || !data.results?.length) {
      const msg = `Geocoding status=${data.status}` +
        (data.error_message ? ` error_message="${data.error_message}"` : "") +
        ` query="${query}"`;
      console.error(`[geocode] ${msg}`);
      options?.onError?.(msg);
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
  } catch (err) {
    const msg = `Geocoding exception: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[geocode] ${msg}`);
    options?.onError?.(msg);
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
