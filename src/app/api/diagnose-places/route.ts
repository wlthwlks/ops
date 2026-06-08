import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Diagnostic endpoint for the Google Maps key. Runs:
 *   1. Geocoding API call (cheap, almost always works if the key is alive)
 *   2. Places API (New) "Nearby Search" call against the geocoded point
 *
 * Returns the raw status codes and bodies (truncated) so the operator can
 * see exactly which surface is failing — most commonly Places API (New) not
 * being enabled on the project, the key being restricted, or billing.
 *
 * No DB writes, no cache mutations. Safe to spam.
 */
export async function GET() {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        ok: false,
        reason: "missing-key",
        message: "GOOGLE_MAPS_API_KEY env var is not set on this environment.",
      },
      { status: 500 }
    );
  }

  // Step 1 — Geocoding
  const geoQuery = "2140, Sydney, Australia";
  const geocodingUrl =
    "https://maps.googleapis.com/maps/api/geocode/json?" +
    new URLSearchParams({ address: geoQuery, key: apiKey }).toString();

  const geocoding: Record<string, unknown> = {
    api: "Geocoding API",
    query: geoQuery,
  };

  let lat: number | null = null;
  let lon: number | null = null;

  try {
    const res = await fetch(geocodingUrl);
    geocoding.httpStatus = res.status;
    const bodyText = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(bodyText); } catch { /* keep raw */ }

    geocoding.status = parsed?.status ?? null;
    geocoding.errorMessage = parsed?.error_message ?? null;
    geocoding.resultCount = parsed?.results?.length ?? 0;
    geocoding.rawBody = bodyText.slice(0, 1000);

    if (parsed?.status === "OK" && parsed.results?.[0]?.geometry?.location) {
      lat = parsed.results[0].geometry.location.lat;
      lon = parsed.results[0].geometry.location.lng;
      geocoding.point = { lat, lon };
    }
  } catch (err) {
    geocoding.exception = err instanceof Error ? err.message : String(err);
  }

  // Step 2 — Places API (New) Nearby Search
  const places: Record<string, unknown> = {
    api: "Places API (New) - searchNearby",
  };

  if (lat == null || lon == null) {
    places.skipped = true;
    places.reason = "no point from geocoding step";
  } else {
    const body = {
      includedTypes: ["park", "library", "shopping_mall"],
      rankPreference: "DISTANCE",
      locationRestriction: {
        circle: { center: { latitude: lat, longitude: lon }, radius: 5_000 },
      },
      maxResultCount: 5,
    };
    places.requestBody = body;

    try {
      const res = await fetch(
        "https://places.googleapis.com/v1/places:searchNearby",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": "places.displayName",
          },
          body: JSON.stringify(body),
        }
      );
      places.httpStatus = res.status;
      const bodyText = await res.text();
      let parsed: any = null;
      try { parsed = JSON.parse(bodyText); } catch { /* keep raw */ }

      places.resultCount = parsed?.places?.length ?? 0;
      places.googleError = parsed?.error ?? null;
      places.rawBody = bodyText.slice(0, 1500);
    } catch (err) {
      places.exception = err instanceof Error ? err.message : String(err);
    }
  }

  // Diagnose the most likely root cause
  const verdict = diagnose(geocoding, places);

  return NextResponse.json({
    ok: verdict.ok,
    verdict: verdict.verdict,
    nextSteps: verdict.nextSteps,
    geocoding,
    places,
  });
}

function diagnose(
  geocoding: Record<string, unknown>,
  places: Record<string, unknown>
): { ok: boolean; verdict: string; nextSteps: string[] } {
  const geoStatus = geocoding.httpStatus as number | undefined;
  const geoApiStatus = geocoding.status as string | null;
  const placesStatus = places.httpStatus as number | undefined;
  const googleError = places.googleError as
    | { code?: number; status?: string; message?: string }
    | null;

  if (geoStatus !== 200 || geoApiStatus !== "OK") {
    if (geoApiStatus === "REQUEST_DENIED") {
      return {
        ok: false,
        verdict: "Geocoding API rejected the key (REQUEST_DENIED).",
        nextSteps: [
          "Confirm the Geocoding API is enabled on the Google Cloud project: https://console.cloud.google.com/apis/library/geocoding-backend.googleapis.com",
          "Check the key's restrictions (Application restrictions: None for server use; API restrictions must include Geocoding API).",
          "Verify billing is active on the project.",
        ],
      };
    }
    return {
      ok: false,
      verdict: `Geocoding failed (HTTP ${geoStatus}, status=${geoApiStatus}).`,
      nextSteps: ["See geocoding.rawBody and geocoding.errorMessage for details."],
    };
  }

  if (placesStatus !== 200) {
    if (placesStatus === 403) {
      return {
        ok: false,
        verdict:
          "Places API (New) returned HTTP 403. The key works for Geocoding but not Places.",
        nextSteps: [
          "Enable Places API (New) — different SKU from legacy Places: https://console.cloud.google.com/apis/library/places.googleapis.com",
          "If recently enabled, wait ~2 minutes for propagation, then re-run this endpoint.",
          "Check API restrictions on the key — it must include 'Places API (New)'.",
        ],
      };
    }
    return {
      ok: false,
      verdict: `Places API (New) returned HTTP ${placesStatus}.`,
      nextSteps: [
        googleError?.message
          ? `Google error: ${googleError.status} — ${googleError.message}`
          : "See places.rawBody for the full response.",
      ],
    };
  }

  if ((places.resultCount as number) === 0) {
    return {
      ok: true,
      verdict:
        "Both APIs responded but Places returned 0 results for this location.",
      nextSteps: [
        "Unusual for a populated postcode; this could be a quota or a sparse-area edge case.",
        "Check daily quota usage: https://console.cloud.google.com/apis/dashboard",
      ],
    };
  }

  return {
    ok: true,
    verdict: `Both APIs healthy. Places returned ${places.resultCount} results.`,
    nextSteps: [],
  };
}
