/**
 * Public Member Directory read model.
 *
 * Lists members whose `Member directory status` is "Active" and maps each to a
 * DTO that exposes ONLY directory-facing fields — never billing, membership,
 * onboarding or other internal fields. Country / industry / stage / matching
 * labels are resolved on the client from reference data (codes + record ids
 * are returned verbatim).
 */
import {
  getFormsAirtableClient,
  recordToProfileDto,
} from "@/lib/forms/airtable/members-sync";
import type { AirtableRecord } from "@/lib/integrations/airtable";
import { MEMBERS_TABLE, MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

export type DirectoryMemberDto = ReturnType<typeof directoryMemberToDto>;

export function directoryMemberToDto(record: AirtableRecord) {
  const p = recordToProfileDto(record);
  const name =
    [p.firstName, p.lastName].filter(Boolean).join(" ") || p.name || "";

  return {
    id: p.airtableRecordId,
    name,
    email: p.email,
    professionalHeadline: p.professionalHeadline,
    businessName: p.businessName,
    city: p.city,
    cityCode: p.cityCode,
    primaryIndustry: p.primaryIndustry,
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

export async function listDirectoryMembers(
  airtable = getFormsAirtableClient()
): Promise<DirectoryMemberDto[]> {
  const records = await airtable.listRecords(MEMBERS_TABLE, {
    filterByFormula: `{${MEMBER_FIELDS.memberDirectoryStatus}} = "Active"`,
  });
  return records.map(directoryMemberToDto);
}
