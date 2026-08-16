import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import { memberGeoCache } from "@/db/schema";
import { geocode } from "@/lib/geo/geocode";
import { collapseSpaces, normalizeCityKey } from "@/lib/ops/city-normalize";

/**
 * Cached geographic coordinates for members, resolved from postcode/zip +
 * city via the Google geocoding integration. Google is only called when the
 * member's location changed (location_hash) or after a failure-backoff
 * window, so repeated matching runs do not re-geocode unchanged members.
 */

export interface ResolvedGeo {
  lat: number | null;
  lon: number | null;
  displayName: string | null;
  /** "cached" | "google" | "none" — none means no coordinates could be resolved. */
  source: "cached" | "google" | "none";
  unknown: boolean;
}

export const GEO_FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1000;

export function normalizePostcode(value: string | null | undefined): string {
  return collapseSpaces(value ?? "").toUpperCase();
}

export function locationHash(postcode: string | null | undefined, city: string | null | undefined): string {
  const raw = `${normalizePostcode(postcode)}|${normalizeCityKey(city ?? "")}`;
  return createHash("sha256").update(raw).digest("hex");
}

export const EARTH_RADIUS_KM = 6371;

export function haversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
}

export interface MemberGeoInput {
  airtableRecordId: string;
  email?: string | null;
  postcode?: string | null;
  city?: string | null;
}

export interface ResolveMemberGeoOptions {
  now?: Date;
  /** Re-attempt geocoding even within the failure backoff window. */
  forceRefresh?: boolean;
  onGeocodeError?: (message: string) => void;
}

async function upsertGeoRow(
  db: AppDb,
  input: {
    airtableRecordId: string;
    email?: string | null;
    postcodeNormalized: string;
    cityNormalized: string;
    locationHash: string;
    lat: number | null;
    lon: number | null;
    displayName: string | null;
    updatedAt: Date;
  }
): Promise<void> {
  await db
    .insert(memberGeoCache)
    .values({
      airtableRecordId: input.airtableRecordId,
      email: input.email ?? null,
      postcodeNormalized: input.postcodeNormalized,
      cityNormalized: input.cityNormalized,
      locationHash: input.locationHash,
      lat: input.lat,
      lon: input.lon,
      displayName: input.displayName,
      source: "google",
      updatedAt: input.updatedAt,
    })
    .onConflictDoUpdate({
      target: memberGeoCache.airtableRecordId,
      set: {
        email: input.email ?? null,
        postcodeNormalized: input.postcodeNormalized,
        cityNormalized: input.cityNormalized,
        locationHash: input.locationHash,
        lat: input.lat,
        lon: input.lon,
        displayName: input.displayName,
        source: "google",
        updatedAt: input.updatedAt,
      },
    });
}

export async function resolveMemberGeo(
  db: AppDb,
  member: MemberGeoInput,
  options: ResolveMemberGeoOptions = {}
): Promise<ResolvedGeo> {
  const now = options.now ?? new Date();
  const postcode = normalizePostcode(member.postcode);
  const city = member.city ?? "";

  if (!postcode) {
    return { lat: null, lon: null, displayName: null, source: "none", unknown: true };
  }

  const hash = locationHash(postcode, city);
  const rows = await db
    .select()
    .from(memberGeoCache)
    .where(eq(memberGeoCache.airtableRecordId, member.airtableRecordId))
    .limit(1);
  const existing = rows[0] ?? null;

  if (existing && existing.locationHash === hash) {
    if (existing.lat != null && existing.lon != null) {
      return {
        lat: existing.lat,
        lon: existing.lon,
        displayName: existing.displayName ?? null,
        source: "cached",
        unknown: false,
      };
    }
    // Previously failed geocode: respect the backoff window.
    const updated = existing.updatedAt ? new Date(existing.updatedAt) : new Date(0);
    if (!options.forceRefresh && now.getTime() - updated.getTime() < GEO_FAILURE_BACKOFF_MS) {
      return { lat: null, lon: null, displayName: null, source: "none", unknown: true };
    }
  }

  const point = await geocode(postcode, city, {
    onError: options.onGeocodeError,
  });

  if (point) {
    await upsertGeoRow(db, {
      airtableRecordId: member.airtableRecordId,
      email: member.email,
      postcodeNormalized: postcode,
      cityNormalized: normalizeCityKey(city),
      locationHash: hash,
      lat: point.lat,
      lon: point.lon,
      displayName: point.displayName,
      updatedAt: now,
    });
    return {
      lat: point.lat,
      lon: point.lon,
      displayName: point.displayName,
      source: "google",
      unknown: false,
    };
  }

  // Record the failure (with the new location hash) so future runs back off
  // instead of hammering Google, and stale coordinates are never served.
  await upsertGeoRow(db, {
    airtableRecordId: member.airtableRecordId,
    email: member.email,
    postcodeNormalized: postcode,
    cityNormalized: normalizeCityKey(city),
    locationHash: hash,
    lat: null,
    lon: null,
    displayName: null,
    updatedAt: now,
  });

  return { lat: null, lon: null, displayName: null, source: "none", unknown: true };
}
