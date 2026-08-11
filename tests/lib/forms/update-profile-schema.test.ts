import { describe, it, expect } from "vitest";
import { updateProfileSchema } from "@/lib/forms/schemas/onboarding";

describe("updateProfileSchema validation error shape", () => {
  it("returns field-level errors via flatten", () => {
    const result = updateProfileSchema.safeParse({
      businessDescription: "too short",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const flat = result.error.flatten();
      expect(flat.fieldErrors).toBeDefined();
      // businessDescription should have an error about min length
      const descErrors = flat.fieldErrors.businessDescription;
      expect(descErrors).toBeDefined();
      expect(Array.isArray(descErrors)).toBe(true);
      expect(descErrors![0]).toBeTruthy();
    }
  });

  it("rejects empty firstName when provided but empty", () => {
    const result = updateProfileSchema.safeParse({
      firstName: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid post code", () => {
    const result = updateProfileSchema.safeParse({
      postCode: "!@#$",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid optional fields", () => {
    const result = updateProfileSchema.safeParse({
      firstName: "Ada",
      lastName: "Lovelace",
      businessDescription:
        "We build tools for founders to connect across 40+ cities worldwide.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing otherIndustry when primaryIndustry is OTHER", () => {
    const result = updateProfileSchema.safeParse({
      primaryIndustry: "OTHER",
      otherIndustry: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts OTHER with a valid otherIndustry", () => {
    const result = updateProfileSchema.safeParse({
      primaryIndustry: "OTHER",
      otherIndustry: "Custom Industry",
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty object (all fields optional)", () => {
    const result = updateProfileSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
