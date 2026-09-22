/**
 * Member Directory opt-in and completeness rules.
 *
 * Single source of truth for what a member must complete before their profile
 * is eligible to appear in the WLTH WLKS Member Directory. The directory has
 * three externally-visible states:
 *
 *   - "Not in directory" — never opted in (or opted out)
 *   - "Incomplete"       — opted in but missing required data
 *   - "Active"           — opted in and complete
 *
 * Airtable stores the state in the `Member directory status` single-select;
 * the required fields are derived here from the resolved profile DTO.
 */

export type DirectoryStatus = "not_in_directory" | "incomplete" | "active";

/** Airtable `Member directory status` option labels. */
export const DIRECTORY_STATUS_VALUES = {
  notInDirectory: "Not in directory",
  incomplete: "Incomplete",
  active: "Active",
} as const;

export const DIRECTORY_REQUIRED_FIELDS = [
  { key: "photo", label: "Profile photo" },
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "professionalHeadline", label: "Headline" },
  { key: "profileBio", label: "Bio" },
  { key: "businessName", label: "Business name" },
  { key: "location", label: "Location" },
  { key: "industry", label: "Industry" },
  { key: "businessWebsite", label: "Website" },
  { key: "socialLinks", label: "At least one social profile" },
] as const;

export type DirectoryRequiredFieldKey =
  (typeof DIRECTORY_REQUIRED_FIELDS)[number]["key"];

export type DirectoryProfileInput = {
  profilePhotoUrls: string[];
  firstName: string;
  lastName: string;
  professionalHeadline: string;
  profileBio: string;
  businessName: string;
  cityCode: string;
  city: string;
  primaryIndustry: string;
  businessWebsite: string;
  socialLinks: Array<{ platform: string; url: string }>;
};

export function missingDirectoryFields(
  p: DirectoryProfileInput
): DirectoryRequiredFieldKey[] {
  const missing: DirectoryRequiredFieldKey[] = [];

  const hasPhoto =
    Array.isArray(p.profilePhotoUrls) &&
    p.profilePhotoUrls.some((u) => (u || "").trim());
  if (!hasPhoto) missing.push("photo");
  if (!(p.firstName || "").trim()) missing.push("firstName");
  if (!(p.lastName || "").trim()) missing.push("lastName");
  if (!(p.professionalHeadline || "").trim()) missing.push("professionalHeadline");
  if (!(p.profileBio || "").trim()) missing.push("profileBio");
  if (!(p.businessName || "").trim()) missing.push("businessName");
  if (!(p.cityCode || "").trim() && !(p.city || "").trim()) missing.push("location");
  if (!(p.primaryIndustry || "").trim()) missing.push("industry");
  if (!(p.businessWebsite || "").trim()) missing.push("businessWebsite");

  const hasSocial =
    Array.isArray(p.socialLinks) &&
    p.socialLinks.some((l) => (l?.platform || "").trim() && (l?.url || "").trim());
  if (!hasSocial) missing.push("socialLinks");

  return missing;
}

export function evaluateDirectoryCompleteness(p: DirectoryProfileInput): {
  missing: DirectoryRequiredFieldKey[];
  complete: boolean;
} {
  const missing = missingDirectoryFields(p);
  return { missing, complete: missing.length === 0 };
}

/** Map a boolean opt-in + completeness into the Airtable status option. */
export function directoryStatusForOptIn(
  requested: boolean,
  complete: boolean
): string {
  if (!requested) return DIRECTORY_STATUS_VALUES.notInDirectory;
  return complete
    ? DIRECTORY_STATUS_VALUES.active
    : DIRECTORY_STATUS_VALUES.incomplete;
}

/** Human labels (for the "what's missing" list) in canonical order. */
export function directoryMissingLabels(missing: DirectoryRequiredFieldKey[]): string[] {
  const map = new Map(DIRECTORY_REQUIRED_FIELDS.map((f) => [f.key, f.label]));
  return missing.map((k) => map.get(k) || k);
}

/** Build the evaluator input from a resolved profile DTO (loose pick). */
export function directoryInputFromProfileDto(p: {
  profilePhoto?: string[];
  firstName?: string;
  lastName?: string;
  professionalHeadline?: string;
  profileBio?: string;
  businessName?: string;
  cityCode?: string;
  city?: string;
  primaryIndustry?: string;
  businessWebsite?: string;
  socialLinks?: Array<{ platform: string; url: string }>;
}): DirectoryProfileInput {
  return {
    profilePhotoUrls: Array.isArray(p.profilePhoto) ? p.profilePhoto : [],
    firstName: p.firstName || "",
    lastName: p.lastName || "",
    professionalHeadline: p.professionalHeadline || "",
    profileBio: p.profileBio || "",
    businessName: p.businessName || "",
    cityCode: p.cityCode || "",
    city: p.city || "",
    primaryIndustry: p.primaryIndustry || "",
    businessWebsite: p.businessWebsite || "",
    socialLinks: Array.isArray(p.socialLinks) ? p.socialLinks : [],
  };
}

/** Normalize a stored Airtable status value into the canonical DirectoryStatus. */
export function normalizeDirectoryStatus(raw: string | null | undefined): DirectoryStatus {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "active") return "active";
  if (s === "incomplete") return "incomplete";
  return "not_in_directory";
}
