import { describe, it, expect } from "vitest";
import {
  normalizeCityKey,
  resolveCanonicalCity,
  isInvalidCityValue,
  buildCityToChannelMap,
} from "@/lib/ops/city-normalize";

const aliases: Record<string, string> = {
  la: "Los Angeles",
  "greater london": "London",
  uk: "London",
  "united kingdom": "London",
  "united kindom": "London",
  "mexico city": "Mexico City",
  "sao paul": "São Paulo",
  "sao paulo": "São Paulo",
  charlotte: "Charlotte",
  "forth worth": "Fort Worth",
  "st petersburg": "St. Petersburg",
  berkley: "Berkeley",
};

const known = new Set([
  "Los Angeles",
  "London",
  "Mexico City",
  "São Paulo",
  "Charlotte",
  "Fort Worth",
  "St. Petersburg",
  "Berkeley",
  "Virtual",
  "Denver",
]);

describe("normalizeCityKey", () => {
  it("trims and case-folds", () => {
    expect(normalizeCityKey("  London  ")).toBe("london");
    expect(normalizeCityKey("CHARLOTTE")).toBe("charlotte");
  });

  it("is accent-insensitive but preserves lookup", () => {
    expect(normalizeCityKey("São Paulo")).toBe(normalizeCityKey("Sao Paulo"));
    expect(normalizeCityKey("València")).toBe(normalizeCityKey("Valencia"));
  });
});

describe("resolveCanonicalCity", () => {
  it("maps LA → Los Angeles", () => {
    const r = resolveCanonicalCity("LA", { aliases, knownCanonicals: known });
    expect(r).toEqual({ ok: true, canonical: "Los Angeles", via: "alias" });
  });

  it("maps Mexico City with trailing space", () => {
    const r = resolveCanonicalCity("Mexico City  ", {
      aliases,
      knownCanonicals: known,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonical).toBe("Mexico City");
  });

  it("maps Greater London and United Kindom → London", () => {
    expect(resolveCanonicalCity("Greater London", { aliases, knownCanonicals: known })).toMatchObject({
      canonical: "London",
    });
    expect(resolveCanonicalCity("United Kindom", { aliases, knownCanonicals: known })).toMatchObject({
      canonical: "London",
    });
  });

  it("maps Sao Paul / Sao Paulo → São Paulo", () => {
    expect(resolveCanonicalCity("Sao Paul", { aliases, knownCanonicals: known })).toMatchObject({
      canonical: "São Paulo",
    });
    expect(resolveCanonicalCity("Sao Paulo", { aliases, knownCanonicals: known })).toMatchObject({
      canonical: "São Paulo",
    });
  });

  it("maps CHARLOTTE, Forth Worth, St Petersburg, Berkley", () => {
    expect(resolveCanonicalCity("CHARLOTTE", { aliases, knownCanonicals: known })).toMatchObject({
      canonical: "Charlotte",
    });
    expect(resolveCanonicalCity("Forth Worth", { aliases, knownCanonicals: known })).toMatchObject({
      canonical: "Fort Worth",
    });
    expect(resolveCanonicalCity("St Petersburg", { aliases, knownCanonicals: known })).toMatchObject({
      canonical: "St. Petersburg",
    });
    expect(resolveCanonicalCity("Berkley", { aliases, knownCanonicals: known })).toMatchObject({
      canonical: "Berkeley",
    });
  });

  it("leaves blank and NA unresolved", () => {
    expect(resolveCanonicalCity("NA", { aliases, knownCanonicals: known }).ok).toBe(false);
    expect(resolveCanonicalCity("", { aliases, knownCanonicals: known }).ok).toBe(false);
    expect(isInvalidCityValue("n/a")).toBe(true);
  });

  it("does not invent fuzzy cities", () => {
    const r = resolveCanonicalCity("SomeRandomVille", {
      aliases,
      knownCanonicals: known,
    });
    expect(r.ok).toBe(false);
  });

  it("virtual fallback only for explicit list", () => {
    const r = resolveCanonicalCity("Berlin", {
      aliases,
      knownCanonicals: known,
      virtualFallbackCities: ["Berlin"],
    });
    expect(r).toEqual({ ok: true, canonical: "Virtual", via: "virtual_fallback" });
  });
});

describe("buildCityToChannelMap", () => {
  it("allows one channel many cities", () => {
    const m = buildCityToChannelMap({
      Denver: ["Denver", "Boulder"],
      Dallas: ["Dallas"],
    });
    expect(m.get(normalizeCityKey("Boulder"))).toBe("Denver");
  });

  it("throws on conflicting channel for same city", () => {
    expect(() =>
      buildCityToChannelMap({
        A: ["Denver"],
        B: ["Denver"],
      })
    ).toThrow(/Conflicting/);
  });
});
