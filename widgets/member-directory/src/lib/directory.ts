export type SocialLink = { platform: string; url: string };

export type DirectoryMemberDto = {
  id: string;
  name: string;
  email: string;
  professionalHeadline: string;
  businessName: string;
  city: string;
  cityCode: string;
  primaryIndustry: string;
  businessStage: string;
  dateJoined: string;
  profilePhoto: string;
  profilePhotoThumb: string;
  profileBio: string;
  businessWebsite: string;
  socialLinks: SocialLink[];
  connectionType: string;
  helpWanted: string[];
  helpWantedContext: string;
  expertiseOffered: string[];
  expertiseContext: string;
};

export type Member = {
  id: string;
  name: string;
  email: string;
  photo: string;
  photoFull: string;
  role: string;
  company: string;
  city: string;
  country: string;
  field: string;
  stage: string;
  joined: string;
  joinedLabel: string;
  isNew: boolean;
  openTo: string;
  lookingFor: string;
  offering: string;
  bio: string;
  website: string;
  linkedin: string;
};

export type RefData = {
  countries: Array<{ code: string; label: string }>;
  cities: Array<{ code: string; label: string; countryCode: string }>;
  industries: Array<{ code: string; label: string }>;
  businessStages: Array<{ code: string; label: string }>;
  connectionTypes: Array<{ code: string; label: string }>;
  helpWantedOptions: Array<{ code: string; label: string }>;
  expertiseOptions: Array<{ code: string; label: string }>;
};

export type Viewer = {
  name: string;
  city: string;
  field: string;
  stage: string;
};

/** Derive the signed-in member's scoring profile from their own profile DTO. */
export function viewerFromProfile(
  profile: { name: string; city: string; primaryIndustry: string; businessStage: string },
  ref: RefData
): Viewer {
  return {
    name: profile.name,
    city: profile.city,
    field: labelFor(profile.primaryIndustry, ref.industries),
    stage: labelFor(profile.businessStage, ref.businessStages),
  };
}

export const PLACEHOLDER =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='50' fill='#262628'/><circle cx='50' cy='38' r='15' fill='#55555a'/><ellipse cx='50' cy='80' rx='24' ry='16' fill='#55555a'/></svg>"
  );

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function labelFor(
  code: string | undefined,
  options: Array<{ code: string; label: string }>
): string {
  if (!code) return "";
  const found = options.find((o) => o.code === code);
  return found?.label || code;
}

function labelsFor(
  ids: string[] | undefined,
  options: Array<{ code: string; label: string }>
): string[] {
  if (!Array.isArray(ids)) return [];
  return ids
    .map((id) => labelFor(id, options))
    .filter(Boolean);
}

function countryFor(cityCode: string, ref: RefData): string {
  if (!cityCode) return "";
  const city = ref.cities.find((c) => c.code === cityCode);
  if (!city) return "";
  return labelFor(city.countryCode, ref.countries);
}

function joinedLabel(dateJoined: string): { joined: string; joinedLabel: string } {
  const d = new Date(dateJoined);
  if (Number.isNaN(d.getTime())) {
    return { joined: dateJoined, joinedLabel: "" };
  }
  const iso = d.toISOString().slice(0, 10);
  return {
    joined: iso,
    joinedLabel: `Joined ${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
  };
}

function isNewMember(dateJoined: string): boolean {
  const d = new Date(dateJoined);
  if (Number.isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() < 30 * 24 * 3600 * 1000;
}

export function mapMember(dto: DirectoryMemberDto, ref: RefData): Member {
  const jl = joinedLabel(dto.dateJoined);
  const openTo = labelFor(dto.connectionType, ref.connectionTypes);

  const lookingParts = [
    labelsFor(dto.helpWanted, ref.helpWantedOptions).join(", "),
    dto.helpWantedContext,
  ].filter(Boolean);

  const offeringParts = [
    labelsFor(dto.expertiseOffered, ref.expertiseOptions).join(", "),
    dto.expertiseContext,
  ].filter(Boolean);

  return {
    id: dto.id,
    name: dto.name,
    email: dto.email,
    photo: dto.profilePhotoThumb || dto.profilePhoto || PLACEHOLDER,
    photoFull: dto.profilePhoto || dto.profilePhotoThumb || PLACEHOLDER,
    role: dto.professionalHeadline,
    company: dto.businessName,
    city: dto.city,
    country: countryFor(dto.cityCode, ref),
    field: labelFor(dto.primaryIndustry, ref.industries),
    stage: labelFor(dto.businessStage, ref.businessStages),
    joined: jl.joined,
    joinedLabel: jl.joinedLabel,
    isNew: isNewMember(dto.dateJoined),
    openTo: openTo && openTo !== "No preference" ? openTo : "",
    lookingFor: lookingParts.join(" · ") || "—",
    offering: offeringParts.join(" · ") || "—",
    bio: dto.profileBio,
    website: dto.businessWebsite,
    linkedin:
      (dto.socialLinks || []).find((l) => l.platform === "linkedin")?.url || "",
  };
}
