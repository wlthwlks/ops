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

export type DirectoryPage = {
  members: Member[];
  viewer: Viewer | null;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  cities: string[];
  fields: Array<{ code: string; label: string }>;
};
