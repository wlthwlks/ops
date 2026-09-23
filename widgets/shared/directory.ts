/**
 * Browser-safe Member Directory completeness mirror.
 * Kept local so Vite widget bundles stay self-contained (no server imports).
 * Field keys MUST stay in sync with `src/lib/forms/directory.ts`.
 */

export type DirectoryFieldKey =
  | "photo"
  | "firstName"
  | "lastName"
  | "professionalHeadline"
  | "profileBio"
  | "businessName"
  | "location"
  | "industry"
  | "businessWebsite"
  | "socialLinks";

export type DirectoryInput = {
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

export const DIRECTORY_FIELD_LABELS: Record<DirectoryFieldKey, string> = {
  photo: "Profile photo",
  firstName: "First name",
  lastName: "Last name",
  professionalHeadline: "Headline",
  profileBio: "Bio",
  businessName: "Business name",
  location: "Location",
  industry: "Industry",
  businessWebsite: "Website",
  socialLinks: "At least one social profile",
};

/** Element id to scroll/focus for each missing field. */
export const DIRECTORY_FIELD_TARGETS: Record<DirectoryFieldKey, string> = {
  photo: "upd-photo",
  firstName: "fn",
  lastName: "ln",
  professionalHeadline: "upd-headline",
  profileBio: "upd-bio",
  businessName: "upd-bizname",
  location: "wlth-city",
  industry: "wlth-ind",
  businessWebsite: "upd-bizweb",
  socialLinks: "wlth-links-section",
};

export function computeMissingDirectoryFields(input: DirectoryInput): DirectoryFieldKey[] {
  const missing: DirectoryFieldKey[] = [];

  const hasPhoto =
    Array.isArray(input.profilePhotoUrls) &&
    input.profilePhotoUrls.some((u) => (u || "").trim());
  if (!hasPhoto) missing.push("photo");
  if (!(input.firstName || "").trim()) missing.push("firstName");
  if (!(input.lastName || "").trim()) missing.push("lastName");
  if (!(input.professionalHeadline || "").trim()) missing.push("professionalHeadline");
  if (!(input.profileBio || "").trim()) missing.push("profileBio");
  if (!(input.businessName || "").trim()) missing.push("businessName");
  if (!(input.cityCode || "").trim() && !(input.city || "").trim()) missing.push("location");
  if (!(input.primaryIndustry || "").trim()) missing.push("industry");
  if (!(input.businessWebsite || "").trim()) missing.push("businessWebsite");

  const hasSocial =
    Array.isArray(input.socialLinks) &&
    input.socialLinks.some((l) => (l?.platform || "").trim() && (l?.url || "").trim());
  if (!hasSocial) missing.push("socialLinks");

  return missing;
}

export function missingDirectoryLabels(missing: DirectoryFieldKey[]): string[] {
  return missing.map((k) => DIRECTORY_FIELD_LABELS[k]);
}

/** Scroll to and briefly highlight the first missing directory field. */
export function scrollToDirectoryField(key: DirectoryFieldKey): void {
  const id = DIRECTORY_FIELD_TARGETS[key];
  const el = id ? document.getElementById(id) : null;
  if (!el) return;

  el.scrollIntoView({ behavior: "smooth", block: "center" });
  if (el instanceof HTMLElement) {
    try {
      el.focus({ preventScroll: true });
    } catch {
      try {
        el.focus();
      } catch {
        /* ignore */
      }
    }
  }

  // Transient highlight — auto-clears. Never sets aria-invalid, which would
  // leave a persistent red border on fields that are only "missing for the
  // directory" (not actually invalid input).
  el.classList.remove("wlth-dir-flash");
  void (el as HTMLElement).offsetWidth; // force reflow so the animation restarts
  el.classList.add("wlth-dir-flash");
  window.setTimeout(() => el.classList.remove("wlth-dir-flash"), 3200);
}
