import type { DirectoryFieldKey } from "../../../shared/directory";

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
  businessDescription: string;
};

export type Viewer = {
  name: string;
  city: string;
  field: string;
  stage: string;
};

export type DirectoryView =
  | "recommended"
  | "same-city"
  | "same-field"
  | "same-stage"
  | "new"
  | "all";

export type DirectoryAccessReason =
  | "ok"
  | "no_record"
  | "not_active_member"
  | "not_opted_in";

export type DirectoryPage = {
  members: Member[];
  viewer: Viewer | null;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  cities: string[];
  fields: Array<{ code: string; label: string }>;
  accessDenied: boolean;
  noRecord: boolean;
  missingFields: DirectoryFieldKey[];
  reason: DirectoryAccessReason;
};
