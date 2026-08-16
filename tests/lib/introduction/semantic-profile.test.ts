import { describe, it, expect } from "vitest";
import {
  SEMANTIC_KINDS,
  buildSemanticTexts,
  computeProfileHash,
  fieldToText,
  hasNoSemanticContent,
  recordIdFromVectorId,
  semanticFieldsFromRecord,
  vectorIdFor,
  vectorIdsFor,
} from "@/lib/introduction/semantic-profile";
import type { AirtableRecord } from "@/lib/integrations/airtable";

function record(fields: Record<string, unknown>): AirtableRecord {
  return { id: "rec_abc123456789", fields };
}

describe("fieldToText", () => {
  it("handles plain strings and blanks", () => {
    expect(fieldToText(" hello ")).toBe("hello");
    expect(fieldToText("")).toBe("");
    expect(fieldToText(null)).toBe("");
    expect(fieldToText(undefined)).toBe("");
    expect(fieldToText(42)).toBe("42");
  });

  it("flattens arrays of strings, skipping bare record ids", () => {
    expect(fieldToText(["GROWTH_MARKETING", "SALES"])).toBe("GROWTH_MARKETING, SALES");
    expect(fieldToText(["recAbc123456789012", "FINANCE"])).toBe("FINANCE");
    expect(fieldToText(["recXyz999999999999"])).toBe("");
  });

  it("extracts labels from linked-object arrays and dedupes", () => {
    expect(
      fieldToText([{ name: "Growth" }, { name: "Growth" }, { id: "rec1", label: "Sales" }])
    ).toBe("Growth, Sales");
  });
});

describe("buildSemanticTexts", () => {
  it("includes semantic fields in the profile text", () => {
    const texts = buildSemanticTexts({
      professionalHeadline: "Founder of a SaaS",
      profileBio: "I love building communities",
      businessDescription: "A tool for coaches",
      connectionType: "COLLABORATOR_OR_REFERRAL",
    });
    expect(texts.profileText).toContain("Founder of a SaaS");
    expect(texts.profileText).toContain("I love building communities");
    expect(texts.profileText).toContain("A tool for coaches");
    expect(texts.profileText).toContain("COLLABORATOR_OR_REFERRAL");
  });

  it("composes help and expertise texts with their contexts", () => {
    const texts = buildSemanticTexts({
      helpWanted: "FUNDRAISING",
      helpWantedContext: "Closing a pre-seed round",
      expertise: "GROWTH_MARKETING",
      expertiseContext: "10 years in B2B SaaS",
      ninetyDayGoal: "Launch v2 to 100 paying customers",
    });
    expect(texts.helpText).toBe("FUNDRAISING. Closing a pre-seed round");
    expect(texts.expertiseText).toBe("GROWTH_MARKETING. 10 years in B2B SaaS");
    expect(texts.goalText).toBe("Launch v2 to 100 paying customers");
  });

  it("treats missing optional parts as empty", () => {
    const texts = buildSemanticTexts({});
    expect(texts.profileText).toBe("");
    expect(texts.helpText).toBe("");
    expect(texts.expertiseText).toBe("");
    expect(texts.goalText).toBe("");
    expect(hasNoSemanticContent(texts)).toBe(true);
  });
});

describe("semanticFieldsFromRecord", () => {
  it("maps canonical Airtable fields and ignores location/industry/stage/availability", () => {
    const fields = semanticFieldsFromRecord(
      record({
        "Professional Headline": "Headline here",
        "Profile Bio": "Bio here",
        "Business description": "Business here",
        "Current 90-day goal": "Goal here",
        "Help wanted": ["FUNDRAISING"],
        "Help wanted context": "Help context",
        Expertise: ["SALES"],
        "Expertise context": "Exp context",
        "Connection type": "SIMILAR_STAGE_PEER",
        City: "London",
        Industry: "TECH_SAAS",
        Revenue: "$100k-$500k",
        "Availability v2": ["mon_morning"],
        "Topics to Discuss": "Crypto investments",
        "post code": "SW1A 1AA",
      })
    );
    expect(fields.professionalHeadline).toBe("Headline here");
    expect(fields.profileBio).toBe("Bio here");
    expect(fields.businessDescription).toBe("Business here");
    expect(fields.ninetyDayGoal).toBe("Goal here");
    expect(fields.helpWanted).toBe("FUNDRAISING");
    expect(fields.connectionType).toBe("SIMILAR_STAGE_PEER");

    // Nothing location/industry/stage-flavoured may leak into the semantic texts.
    const texts = buildSemanticTexts(fields);
    const combined = [
      texts.profileText,
      texts.helpText,
      texts.expertiseText,
      texts.goalText,
    ].join(" ");
    expect(combined.toLowerCase()).not.toContain("london");
    expect(combined.toLowerCase()).not.toContain("tech_saas");
    expect(combined.toLowerCase()).not.toContain("$100k");
    expect(combined.toLowerCase()).not.toContain("mon_morning");
    expect(combined.toLowerCase()).not.toContain("crypto");
  });
});

describe("profile hash", () => {
  it("is stable and changes when a semantic field changes", () => {
    const base = { professionalHeadline: "Founder" };
    const hashA = computeProfileHash(base);
    const hashB = computeProfileHash({ professionalHeadline: "Founder" });
    const hashC = computeProfileHash({ professionalHeadline: "CEO" });
    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(hashC);
  });

  it("ignores non-semantic changes by construction (no fields to vary)", () => {
    const a = computeProfileHash({ profileBio: "Bio" });
    const b = computeProfileHash({ profileBio: "Bio", businessDescription: "" });
    expect(a).toBe(b);
  });
});

describe("vector ids", () => {
  it("builds kind-suffixed ids and round-trips", () => {
    const ids = vectorIdsFor("rec_abc123456789012");
    expect(ids.profile).toBe("rec_abc123456789012:profile");
    expect(ids.help).toBe("rec_abc123456789012:help");
    expect(ids.expertise).toBe("rec_abc123456789012:expertise");
    expect(ids.goal).toBe("rec_abc123456789012:goal");

    for (const kind of SEMANTIC_KINDS) {
      expect(recordIdFromVectorId(vectorIdFor("rec_x123456789012", kind))).toBe("rec_x123456789012");
    }
    expect(recordIdFromVectorId("rec_x123456789012:unknown")).toBeNull();
    expect(recordIdFromVectorId("rec_x123456789012")).toBeNull();
    expect(recordIdFromVectorId("plain-vector-id")).toBeNull();
  });
});
