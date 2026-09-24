/**
 * Public Member Directory read model with server-side search / filter / sort
 * and pagination.
 *
 * Lists members whose `Member directory status` is "Active" AND whose
 * `Membership` is "Active" AND `Payment` is "Paid", resolves human-readable
 * labels server-side (industry, stage, connection type, help/expertise areas,
 * country), then filters, sorts and paginates.
 */
import {
  getFormsAirtableClient,
  recordToProfileDto,
  findMemberByMemberstackId,
} from "@/lib/forms/airtable/members-sync";
import {
  loadLocationCatalog,
  loadMatchingOptionsCatalog,
  INDUSTRIES,
  BUSINESS_STAGES,
  CONNECTION_TYPES,
} from "@/lib/forms/reference-data";
import type { AirtableRecord } from "@/lib/integrations/airtable";
import { MEMBERS_TABLE, MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

export type DirectoryView =
  | "recommended"
  | "same-city"
  | "same-field"
  | "same-stage"
  | "new"
  | "all";

/** Raw public fields straight from the Airtable record (codes / ids). */
export type DirectoryMemberDto = ReturnType<typeof directoryMemberToDto>;

/** Display-ready member returned to the widget. */
export type DirectoryMember = {
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

export type DirectoryViewer = {
  name: string;
  city: string;
  field: string;
  stage: string;
};

export type DirectoryPageParams = {
  q?: string;
  city?: string;
  field?: string;
  view?: DirectoryView;
  page: number;
  pageSize: number;
  viewerMemberstackId: string;
};

export type DirectoryPage = {
  members: DirectoryMember[];
  viewer: DirectoryViewer | null;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  cities: string[];
  fields: Array<{ code: string; label: string }>;
};

export function directoryMemberToDto(record: AirtableRecord) {
  const p = recordToProfileDto(record);
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || p.name || "";

  return {
    id: p.airtableRecordId,
    name,
    email: p.email,
    professionalHeadline: p.professionalHeadline,
    businessName: p.businessName,
    city: p.city,
    cityCode: p.cityCode,
    primaryIndustry: p.primaryIndustry,
    otherIndustry: p.otherIndustry,
    businessStage: p.businessStage,
    dateJoined: p.dateJoined,
    profilePhoto: p.profilePhoto?.[0] || "",
    profilePhotoThumb: p.profilePhotoThumb || p.profilePhoto?.[0] || "",
    profileBio: p.profileBio,
    businessWebsite: p.businessWebsite,
    socialLinks: p.socialLinks,
    connectionType: p.connectionType,
    helpWanted: p.helpWanted,
    helpWantedContext: p.helpWantedContext,
    expertiseOffered: p.expertiseOffered,
    expertiseContext: p.expertiseContext,
  };
}

const PLACEHOLDER =
  "data:image/svg+xml;charset=utf-8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='50' fill='#262628'/><circle cx='50' cy='38' r='15' fill='#55555a'/><ellipse cx='50' cy='80' rx='24' ry='16' fill='#55555a'/></svg>"
  );

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function joinedParts(dateJoined: string): { joined: string; joinedLabel: string } {
  const d = new Date(dateJoined);
  if (Number.isNaN(d.getTime())) return { joined: dateJoined, joinedLabel: "" };
  return {
    joined: d.toISOString().slice(0, 10),
    joinedLabel: `Joined ${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
  };
}

function isNewMember(dateJoined: string): boolean {
  const d = new Date(dateJoined);
  if (Number.isNaN(d.getTime())) return false;
  return Date.now() - d.getTime() < 30 * 24 * 3600 * 1000;
}

type ResolvedRefs = {
  industryLabels: Map<string, string>;
  stageLabels: Map<string, string>;
  connectionLabels: Map<string, string>;
  helpLabels: Map<string, string>;
  expertiseLabels: Map<string, string>;
  cityByCode: Map<string, { label: string; countryLabel: string }>;
};

async function buildRefs(): Promise<ResolvedRefs> {
  const [loc, matching] = await Promise.all([
    loadLocationCatalog(),
    loadMatchingOptionsCatalog(),
  ]);
  return {
    industryLabels: new Map(INDUSTRIES.map((i) => [i.code, i.label])),
    stageLabels: new Map(BUSINESS_STAGES.map((s) => [s.code, s.label])),
    connectionLabels: new Map(CONNECTION_TYPES.map((c) => [c.code, c.label])),
    helpLabels: new Map(matching.helpWantedOptions.map((o) => [o.code, o.label])),
    expertiseLabels: new Map(matching.expertiseOptions.map((o) => [o.code, o.label])),
    cityByCode: new Map(
      loc.cities.map((c) => [
        c.code,
        { label: c.legacyCityLabel || c.label, countryLabel: c.countryLabel },
      ])
    ),
  };
}

function industryLabel(raw: DirectoryMemberDto, refs: ResolvedRefs): string {
  if (raw.primaryIndustry === "OTHER") return raw.otherIndustry || "Other";
  return refs.industryLabels.get(raw.primaryIndustry) || raw.primaryIndustry;
}

function resolveMember(raw: DirectoryMemberDto, refs: ResolvedRefs): DirectoryMember {
  const cityInfo = raw.cityCode ? refs.cityByCode.get(raw.cityCode) : undefined;
  const j = joinedParts(raw.dateJoined);

  const openTo = raw.connectionType
    ? refs.connectionLabels.get(raw.connectionType) || ""
    : "";
  const lookingFor = [
    raw.helpWanted
      .map((id) => refs.helpLabels.get(id) || "")
      .filter(Boolean)
      .join(", "),
    raw.helpWantedContext,
  ]
    .filter(Boolean)
    .join(" · ");
  const offering = [
    raw.expertiseOffered
      .map((id) => refs.expertiseLabels.get(id) || "")
      .filter(Boolean)
      .join(", "),
    raw.expertiseContext,
  ]
    .filter(Boolean)
    .join(" · ");

  const linkedin =
    (raw.socialLinks || []).find((l) => l.platform === "linkedin")?.url || "";

  return {
    id: raw.id,
    name: raw.name,
    email: raw.email,
    photo: raw.profilePhotoThumb || raw.profilePhoto || PLACEHOLDER,
    photoFull: raw.profilePhoto || raw.profilePhotoThumb || PLACEHOLDER,
    role: raw.professionalHeadline,
    company: raw.businessName,
    city: raw.city || cityInfo?.label || "",
    country: cityInfo?.countryLabel || "",
    field: industryLabel(raw, refs),
    stage: refs.stageLabels.get(raw.businessStage) || raw.businessStage,
    joined: j.joined,
    joinedLabel: j.joinedLabel,
    isNew: isNewMember(raw.dateJoined),
    openTo: openTo && openTo !== "No preference" ? openTo : "",
    lookingFor: lookingFor || "—",
    offering: offering || "—",
    bio: raw.profileBio,
    website: raw.businessWebsite,
    linkedin,
  };
}

type ViewerRaw = {
  name: string;
  city: string;
  primaryIndustry: string;
  otherIndustry: string;
  businessStage: string;
};

async function resolveViewer(memberstackId: string): Promise<ViewerRaw | null> {
  const rows = await findMemberByMemberstackId(memberstackId);
  if (rows.length === 0) return null;
  const p = recordToProfileDto(rows[0]);
  return {
    name: [p.firstName, p.lastName].filter(Boolean).join(" ") || p.name || "",
    city: p.city,
    primaryIndustry: p.primaryIndustry,
    otherIndustry: p.otherIndustry,
    businessStage: p.businessStage,
  };
}

function viewerFieldLabel(v: ViewerRaw, refs: ResolvedRefs): string {
  if (v.primaryIndustry === "OTHER") return v.otherIndustry || "Other";
  return refs.industryLabels.get(v.primaryIndustry) || v.primaryIndustry;
}

function score(member: DirectoryMember, viewer: ViewerRaw | null, refs: ResolvedRefs) {
  if (!viewer) return 0;
  let s = 0;
  if (member.city === viewer.city) s += 4;
  if (member.field === viewerFieldLabel(viewer, refs)) s += 3;
  if (member.stage === refs.stageLabels.get(viewer.businessStage)) s += 2;
  if (member.isNew) s += 1;
  return s;
}

export async function listDirectoryMembersPage(
  params: DirectoryPageParams,
  airtable = getFormsAirtableClient()
): Promise<DirectoryPage> {
  const page = Math.max(1, Math.floor(params.page) || 1);
  const pageSize = Math.min(48, Math.max(1, Math.floor(params.pageSize) || 12));
  const view: DirectoryView = params.view || "recommended";

  const refs = await buildRefs();
  const [rawRecords, viewer] = await Promise.all([
    airtable.listRecords(MEMBERS_TABLE, {
      filterByFormula: `AND({${MEMBER_FIELDS.memberDirectoryStatus}} = "Active", {${MEMBER_FIELDS.membership}} = "Active", {${MEMBER_FIELDS.payment}} = "Paid")`,
    }),
    resolveViewer(params.viewerMemberstackId),
  ]);

  const all = rawRecords
    .map(directoryMemberToDto)
    .map((raw) => resolveMember(raw, refs));

  const q = (params.q || "").trim().toLowerCase();
  const cityFilter = (params.city || "").trim();
  const fieldFilter = (params.field || "").trim();

  // Distinct filter options from the full active set.
  const cities = [...new Set(all.map((m) => m.city).filter(Boolean))].sort();
  const fieldMap = new Map<string, string>();
  for (const raw of rawRecords.map(directoryMemberToDto)) {
    if (raw.primaryIndustry) {
      fieldMap.set(raw.primaryIndustry, industryLabel(raw, refs));
    }
  }
  const fields = [...fieldMap.entries()]
    .map(([code, label]) => ({ code, label }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const viewerCity = viewer?.city ?? "";
  const viewerField = viewer ? viewerFieldLabel(viewer, refs) : "";
  const viewerStage = viewer ? refs.stageLabels.get(viewer.businessStage) || "" : "";

  let filtered = all.filter((m) => {
    if (view === "same-city" && m.city !== viewerCity) return false;
    if (view === "same-field" && m.field !== viewerField) return false;
    if (view === "same-stage" && m.stage !== viewerStage) return false;
    if (view === "new" && !m.isNew) return false;

    if (cityFilter && m.city !== cityFilter) return false;
    if (fieldFilter && m.field !== fieldFilter) return false;

    if (q) {
      const haystack = [
        m.name, m.email, m.role, m.company, m.city, m.country, m.field,
        m.stage, m.bio, m.lookingFor, m.offering, m.openTo,
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }

    return true;
  });

  if (view === "recommended") {
    filtered = [...filtered].sort(
      (a, b) =>
        score(b, viewer, refs) - score(a, viewer, refs) || a.name.localeCompare(b.name)
    );
  } else if (view === "new") {
    filtered = [...filtered].sort((a, b) => b.joined.localeCompare(a.joined));
  } else {
    filtered = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;
  const members = filtered.slice(start, start + pageSize);

  return {
    members,
    viewer: viewer
      ? { name: viewer.name, city: viewer.city, field: viewerField, stage: viewerStage }
      : null,
    total,
    page,
    pageSize,
    totalPages,
    cities,
    fields,
  };
}
