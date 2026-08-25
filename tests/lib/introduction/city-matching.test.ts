import { describe, it, expect } from "vitest";
import {
  canonicalizeCityName,
  cityAliasFilterFormula,
} from "@/lib/introduction/city-matching";

describe("canonicalizeCityName", () => {
  it("resolves aliases to the canonical label", () => {
    expect(canonicalizeCityName("LA")).toBe("Los Angeles");
    expect(canonicalizeCityName("los ángeles")).toBe("Los Angeles");
    expect(canonicalizeCityName("Los Angeles")).toBe("Los Angeles");
    expect(canonicalizeCityName("Pasadena")).toBe("Los Angeles");
    expect(canonicalizeCityName("St Albans")).toBe("London");
  });

  it("keeps unknown values as-is and empties blanks", () => {
    expect(canonicalizeCityName("Atlantis")).toBe("Atlantis");
    expect(canonicalizeCityName("  ")).toBe("");
    expect(canonicalizeCityName(null)).toBe("");
    expect(canonicalizeCityName(undefined)).toBe("");
  });
});

describe("cityAliasFilterFormula", () => {
  it("matches the canonical name and every alias", () => {
    const formula = cityAliasFilterFormula("Los Angeles");
    expect(formula).toContain('FIND(LOWER("Los Angeles"), LOWER({City}))');
    expect(formula).toContain('LOWER(TRIM({City})) = LOWER("LA")');
    expect(formula).toContain('FIND(LOWER("Pasadena"), LOWER({City}))');
    expect(formula.startsWith("OR(")).toBe(true);
  });

  it("accepts an alias as input and still uses the canonical set", () => {
    const formula = cityAliasFilterFormula("LA");
    expect(formula).toContain('FIND(LOWER("Los Angeles"), LOWER({City}))');
    expect(formula).toContain('LOWER(TRIM({City})) = LOWER("LA")');
  });

  it("uses exact equality for short aliases so they never substring-match", () => {
    const formula = cityAliasFilterFormula("Los Angeles");
    // "LA" must not appear as a FIND, or cities like "Atlanta" would match.
    expect(formula).not.toContain('FIND(LOWER("LA")');
  });

  it("falls back to a single FIND for unknown cities", () => {
    const formula = cityAliasFilterFormula("Atlantis");
    expect(formula).toBe('OR(FIND(LOWER("Atlantis"), LOWER({City})))');
  });
});
