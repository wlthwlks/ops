import { describe, it, expect, vi, afterAll, beforeAll, beforeEach } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  resolveMemberGeo,
  haversineDistanceKm,
  locationHash,
  normalizePostcode,
  GEO_FAILURE_BACKOFF_MS,
} from "@/lib/introduction/geo-cache";
import { geocode } from "@/lib/geo/geocode";

vi.mock("@/lib/geo/geocode", () => ({
  geocode: vi.fn(),
  extractOutcode: (value: string) => value,
}));

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

const member = {
  airtableRecordId: "rec_geo_1",
  email: "geo@example.com",
  postcode: "SW1A 1AA",
  city: "London",
};

const londonPoint = { lat: 51.5074, lon: -0.1278, displayName: "London SW1A 1AA, UK" };

beforeAll(async () => {
  const test = await createTestDb({ introductionsV2: true });
  db = test.db;
  close = test.close;
});

afterAll(async () => {
  await close();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await resetIntroductionsV2Tables(db);
});

describe("resolveMemberGeo", () => {
  it("geocodes once and serves subsequent calls from cache", async () => {
    vi.mocked(geocode).mockResolvedValue(londonPoint);

    const first = await resolveMemberGeo(db, member);
    expect(first).toEqual({
      lat: 51.5074,
      lon: -0.1278,
      displayName: "London SW1A 1AA, UK",
      source: "google",
      unknown: false,
    });

    const second = await resolveMemberGeo(db, member);
    expect(second.source).toBe("cached");
    expect(second.lat).toBe(51.5074);
    expect(geocode).toHaveBeenCalledTimes(1);
  });

  it("re-geocodes when the member's location changed", async () => {
    vi.mocked(geocode).mockResolvedValue(londonPoint);
    await resolveMemberGeo(db, member);

    vi.mocked(geocode).mockResolvedValue({ lat: 53.4808, lon: -2.2426, displayName: "Manchester, UK" });
    const result = await resolveMemberGeo(db, { ...member, postcode: "M1 1AE", city: "Manchester" });
    expect(result.source).toBe("google");
    expect(result.lat).toBe(53.4808);
    expect(geocode).toHaveBeenCalledTimes(2);
  });

  it("backs off after a geocode failure and retries on forceRefresh", async () => {
    vi.mocked(geocode).mockResolvedValue(null);

    const failed = await resolveMemberGeo(db, member);
    expect(failed.unknown).toBe(true);
    expect(failed.source).toBe("none");

    // Within backoff: no new Google call.
    await resolveMemberGeo(db, member);
    expect(geocode).toHaveBeenCalledTimes(1);

    // forceRefresh bypasses the backoff.
    await resolveMemberGeo(db, member, { forceRefresh: true });
    expect(geocode).toHaveBeenCalledTimes(2);
  });

  it("does not serve stale coordinates after a location change fails to geocode", async () => {
    vi.mocked(geocode).mockResolvedValue(londonPoint);
    await resolveMemberGeo(db, member);

    vi.mocked(geocode).mockResolvedValue(null);
    const result = await resolveMemberGeo(db, { ...member, postcode: "ZZ9 9ZZ" });
    expect(result.unknown).toBe(true);
    expect(result.lat).toBeNull();

    // The stale London coordinates must not leak through.
    const again = await resolveMemberGeo(db, { ...member, postcode: "ZZ9 9ZZ" });
    expect(again.lat).toBeNull();
  });

  it("returns unknown without calling Google when the postcode is blank", async () => {
    const result = await resolveMemberGeo(db, { ...member, postcode: "" });
    expect(result).toEqual({ lat: null, lon: null, displayName: null, source: "none", unknown: true });
    expect(geocode).not.toHaveBeenCalled();
  });

  it("passes geocode errors to the callback", async () => {
    vi.mocked(geocode).mockImplementation(async (_postcode, _city, options) => {
      options?.onError?.("GOOGLE_MAPS_API_KEY env var is missing");
      return null;
    });
    const errors: string[] = [];
    await resolveMemberGeo(db, member, { onGeocodeError: (msg) => errors.push(msg) });
    expect(errors).toHaveLength(1);
  });

  it("applies the backoff window before retrying a previously failed member", async () => {
    vi.mocked(geocode).mockResolvedValue(null);
    await resolveMemberGeo(db, member, { now: new Date("2026-08-01T00:00:00Z") });

    vi.mocked(geocode).mockResolvedValue(londonPoint);
    const stillUnknown = await resolveMemberGeo(db, member, {
      now: new Date("2026-08-01T12:00:00Z"),
    });
    expect(stillUnknown.unknown).toBe(true);

    const afterBackoff = await resolveMemberGeo(db, member, {
      now: new Date("2026-08-01T00:00:00Z").getTime() + GEO_FAILURE_BACKOFF_MS + 1000 > 0
        ? new Date(new Date("2026-08-01T00:00:00Z").getTime() + GEO_FAILURE_BACKOFF_MS + 1000)
        : new Date(),
    });
    expect(afterBackoff.source).toBe("google");
    expect(afterBackoff.unknown).toBe(false);
  });
});

describe("haversineDistanceKm", () => {
  it("returns 0 for the same point", () => {
    expect(haversineDistanceKm(51.5, -0.12, 51.5, -0.12)).toBe(0);
  });

  it("computes a realistic London to Paris distance", () => {
    const distance = haversineDistanceKm(51.5074, -0.1278, 48.8566, 2.3522);
    expect(distance).toBeGreaterThan(330);
    expect(distance).toBeLessThan(360);
  });
});

describe("location helpers", () => {
  it("normalizes postcodes", () => {
    expect(normalizePostcode("  sw1a 1aa ")).toBe("SW1A 1AA");
    expect(normalizePostcode(null)).toBe("");
  });

  it("produces stable location hashes insensitive to case/space", () => {
    expect(locationHash("SW1A 1AA", "London")).toBe(locationHash("sw1a 1aa", " london "));
    expect(locationHash("SW1A 1AA", "London")).not.toBe(locationHash("M1 1AE", "London"));
  });
});
