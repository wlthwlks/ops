import { describe, it, expect } from "vitest";
import {
  evaluateDirectoryCompleteness,
  missingDirectoryFields,
  directoryStatusForOptIn,
  directoryMissingLabels,
  normalizeDirectoryStatus,
  directoryInputFromProfileDto,
  type DirectoryProfileInput,
} from "@/lib/forms/directory";

function completeInput(overrides: Partial<DirectoryProfileInput> = {}): DirectoryProfileInput {
  return {
    profilePhotoUrls: ["https://example.com/photo.jpg"],
    firstName: "Ada",
    lastName: "Lovelace",
    professionalHeadline: "Founder",
    profileBio: "A bio with enough detail to be useful to other members.",
    businessName: "Acme",
    cityCode: "recCity12345",
    city: "London",
    primaryIndustry: "TECHNOLOGY",
    businessWebsite: "https://acme.com",
    socialLinks: [{ platform: "linkedin", url: "https://www.linkedin.com/in/ada" }],
    ...overrides,
  };
}

describe("evaluateDirectoryCompleteness", () => {
  it("complete profile → no missing fields", () => {
    const { missing, complete } = evaluateDirectoryCompleteness(completeInput());
    expect(missing).toEqual([]);
    expect(complete).toBe(true);
  });

  it("flags every missing field", () => {
    const { missing } = evaluateDirectoryCompleteness(
      completeInput({
        profilePhotoUrls: [],
        firstName: "",
        lastName: "",
        professionalHeadline: "",
        profileBio: "",
        businessName: "",
        cityCode: "",
        city: "",
        primaryIndustry: "",
        businessWebsite: "",
        socialLinks: [],
      })
    );
    expect(missing).toEqual([
      "photo",
      "firstName",
      "lastName",
      "professionalHeadline",
      "profileBio",
      "businessName",
      "location",
      "industry",
      "businessWebsite",
      "socialLinks",
    ]);
  });

  it("missing photo only is reported as photo", () => {
    const { missing } = evaluateDirectoryCompleteness(
      completeInput({ profilePhotoUrls: [] })
    );
    expect(missing).toEqual(["photo"]);
  });

  it("social links require both platform and url", () => {
    const { missing } = evaluateDirectoryCompleteness(
      completeInput({ socialLinks: [{ platform: "linkedin", url: "" }] })
    );
    expect(missing).toEqual(["socialLinks"]);
  });

  it("location satisfied by city text even without cityCode", () => {
    const { missing } = evaluateDirectoryCompleteness(
      completeInput({ cityCode: "", city: "London" })
    );
    expect(missing).not.toContain("location");
  });
});

describe("directoryStatusForOptIn", () => {
  it("not requested → Not in directory regardless of completeness", () => {
    expect(directoryStatusForOptIn(false, true)).toBe("Not in directory");
    expect(directoryStatusForOptIn(false, false)).toBe("Not in directory");
  });

  it("requested + complete → Active", () => {
    expect(directoryStatusForOptIn(true, true)).toBe("Active");
  });

  it("requested + incomplete → Incomplete", () => {
    expect(directoryStatusForOptIn(true, false)).toBe("Incomplete");
  });
});

describe("directoryMissingLabels", () => {
  it("maps keys to human labels", () => {
    expect(directoryMissingLabels(["photo", "businessWebsite"])).toEqual([
      "Profile photo",
      "Website",
    ]);
  });
});

describe("normalizeDirectoryStatus", () => {
  it("maps stored values to canonical statuses", () => {
    expect(normalizeDirectoryStatus("Active")).toBe("active");
    expect(normalizeDirectoryStatus("incomplete")).toBe("incomplete");
    expect(normalizeDirectoryStatus("Not in directory")).toBe("not_in_directory");
    expect(normalizeDirectoryStatus("")).toBe("not_in_directory");
    expect(normalizeDirectoryStatus(null)).toBe("not_in_directory");
  });
});

describe("directoryInputFromProfileDto", () => {
  it("coerces null/undefined fields to safe defaults", () => {
    const input = directoryInputFromProfileDto({});
    expect(missingDirectoryFields(input)).toHaveLength(10);
  });
});
