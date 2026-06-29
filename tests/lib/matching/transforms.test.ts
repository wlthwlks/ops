import { describe, it, expect } from "vitest";
import { buildEmbeddingText } from "@/lib/matching/transforms";

const base = {
  nearbyLocation: "Shoreditch, Old Street | Hackney",
  businessStage: "Early Scale",
  industry: "SaaS",
};

describe("buildEmbeddingText", () => {
  it("omits availability/topics sections when both are absent", () => {
    const text = buildEmbeddingText(base);
    expect(text).not.toMatch(/Availability:/);
    expect(text).not.toMatch(/Wants to discuss:/);
    expect(text).not.toMatch(/Interested in:/);
  });

  it("produces the exact same string as before when availability/topics are absent (no drift)", () => {
    // This is the byte-for-byte string the current implementation emits, so
    // ~98% of members re-embed to an identical vector.
    const expected =
      "Located near: Shoreditch, Old Street. " +
      "Nearby areas: Shoreditch, Old Street. " +
      "Close to: Shoreditch, Old Street. " +
      "Business stage: Early Scale. " +
      "Revenue stage: Early Scale. " +
      "Industry: saas. " +
      "Sector: saas.";
    expect(buildEmbeddingText(base)).toBe(expected);
    // Passing empty strings must behave the same as omitting them.
    expect(buildEmbeddingText({ ...base, availability: "", topics: "" })).toBe(expected);
  });

  it("appends topics twice (stronger affinity weight) when present", () => {
    const text = buildEmbeddingText({ ...base, topics: "pricing, hiring" });
    expect(text).toContain("Wants to discuss: pricing, hiring.");
    expect(text).toContain("Interested in: pricing, hiring.");
  });

  it("appends availability once when present", () => {
    const text = buildEmbeddingText({ ...base, availability: "Weekday mornings" });
    expect(text).toContain("Availability: Weekday mornings.");
    // availability is logistics, not affinity → single mention only
    expect(text.match(/Availability:/g)?.length).toBe(1);
  });

  it("appends both, with topics before availability, after the industry sections", () => {
    const text = buildEmbeddingText({
      ...base,
      topics: "growth",
      availability: "Weekends",
    });
    const sectorIdx = text.indexOf("Sector:");
    const topicsIdx = text.indexOf("Wants to discuss:");
    const availIdx = text.indexOf("Availability:");
    expect(sectorIdx).toBeLessThan(topicsIdx);
    expect(topicsIdx).toBeLessThan(availIdx);
  });

  it("trims whitespace-only availability/topics to nothing", () => {
    const text = buildEmbeddingText({ ...base, availability: "   ", topics: "  " });
    expect(text).not.toMatch(/Availability:/);
    expect(text).not.toMatch(/Wants to discuss:/);
  });
});
