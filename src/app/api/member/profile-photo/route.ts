import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";
import { optionsCors, withCors } from "@/lib/forms/cors";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import {
  recordToProfileDtoResolved,
  updateMemberProfile,
  applyMemberDirectoryStatus,
  findMemberByMemberstackId,
} from "@/lib/forms/airtable/members-sync";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import { FormsError } from "@/lib/forms/errors";
import { getFormFeatureFlags } from "@/lib/forms/feature-flags";
import { enforcePublicWriteRateLimit } from "@/lib/forms/http";
import { recordIntegrationError } from "@/lib/forms/webhooks/store";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** Read the member's current profile-photo blob URL (blank if none). */
async function readCurrentPhotoUrl(memberstackId: string): Promise<string> {
  const rows = await findMemberByMemberstackId(memberstackId);
  const v = rows[0]?.fields?.[MEMBER_FIELDS.profilePhotoUrl];
  return typeof v === "string" ? v.trim() : "";
}

/** Best-effort blob deletion — never throws, never blocks the response. */
async function deleteBlobBestEffort(
  url: string,
  memberstackId: string
): Promise<void> {
  if (!url) return;
  try {
    await del(url);
    console.error(
      JSON.stringify({
        event: "profile_photo_blob_deleted",
        memberstackId,
        url,
      })
    );
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "profile_photo_blob_delete_failed",
        memberstackId,
        url,
        error: e instanceof Error ? e.message : String(e),
      })
    );
  }
}

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

/**
 * Upload a member profile photo to Vercel Blob and write the public URL to
 * the Airtable `Profile photo` attachment field.
 */
export async function POST(request: Request) {
  try {
    const limited = enforcePublicWriteRateLimit(request, "member-profile-photo");
    if (limited) return limited;

    const flags = getFormFeatureFlags();
    if (!flags.memberDirectoryEnabled) {
      return withCors(
        NextResponse.json(
          {
            success: false,
            code: "FLAG_DISABLED",
            message: "MEMBER_DIRECTORY_ENABLED is false",
          },
          { status: 503 }
        ),
        request
      );
    }

    const member = await verifyMemberstackToken(
      extractMemberstackToken(request),
      request
    );

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return withCors(
        NextResponse.json(
          { success: false, code: "PROFILE_VALIDATION_FAILED", message: "No photo file provided" },
          { status: 400 }
        ),
        request
      );
    }

    const contentType = (file.type || "").toLowerCase();
    if (!ALLOWED_TYPES.has(contentType)) {
      return withCors(
        NextResponse.json(
          {
            success: false,
            code: "PROFILE_VALIDATION_FAILED",
            message: "Please upload a JPG, PNG or WebP image.",
          },
          { status: 400 }
        ),
        request
      );
    }
    if (file.size > MAX_BYTES) {
      return withCors(
        NextResponse.json(
          {
            success: false,
            code: "PROFILE_VALIDATION_FAILED",
            message: "Please choose an image under 5MB.",
          },
          { status: 400 }
        ),
        request
      );
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const ext = contentType === "image/png" ? "png" : contentType === "image/webp" ? "webp" : "jpg";

    // Read the previous blob URL so we can delete it after the new photo is saved.
    const oldUrl = await readCurrentPhotoUrl(member.id);

    const blob = await put(`profile-photos/${member.id}.${ext}`, bytes, {
      access: "public",
      contentType,
      addRandomSuffix: true,
    });

    const result = await updateMemberProfile({
      memberstackId: member.id,
      patch: {
        [MEMBER_FIELDS.profilePhotoUrl]: blob.url,
        [MEMBER_FIELDS.profilePhoto]: [
          { url: blob.url, filename: file.name || `photo.${ext}` },
        ],
      },
    });

    // Best-effort cleanup of the previous blob (never blocks the response).
    if (oldUrl && oldUrl !== blob.url) {
      await deleteBlobBestEffort(oldUrl, member.id);
    }

    console.error(
      JSON.stringify({
        event: "profile_photo_uploaded",
        memberstackId: member.id,
        airtableRecordId: result.record?.id ?? null,
        url: blob.url,
        previousUrl: oldUrl || null,
        bytes: file.size,
        contentType,
        shadowed: result.shadowed,
      })
    );

    return withCors(
      NextResponse.json({
        success: true,
        url: blob.url,
        profile: await recordToProfileDtoResolved(result.record),
      }),
      request
    );
  } catch (err) {
    if (err instanceof FormsError) {
      return withCors(
        NextResponse.json(
          { success: false, code: err.code, message: err.message },
          { status: err.status }
        ),
        request
      );
    }
    await recordIntegrationError({
      code: "INTERNAL_UNEXPECTED_ERROR",
      source: "member_profile_photo",
      operation: "POST /api/member/profile-photo",
      title: "Profile photo upload failed",
      message: err instanceof Error ? err.message : String(err),
      severity: "error",
    }).catch(() => undefined);
    return withCors(
      NextResponse.json(
        {
          success: false,
          code: "INTERNAL_UNEXPECTED_ERROR",
          message: "Photo upload failed. Please try again.",
        },
        { status: 500 }
      ),
      request
    );
  }
}

/**
 * Remove the member's profile photo (clear the Airtable attachment).
 */
export async function DELETE(request: Request) {
  try {
    const limited = enforcePublicWriteRateLimit(request, "member-profile-photo");
    if (limited) return limited;

    const flags = getFormFeatureFlags();
    if (!flags.memberDirectoryEnabled) {
      return withCors(
        NextResponse.json(
          { success: false, code: "FLAG_DISABLED", message: "MEMBER_DIRECTORY_ENABLED is false" },
          { status: 503 }
        ),
        request
      );
    }

    const member = await verifyMemberstackToken(
      extractMemberstackToken(request),
      request
    );

    const oldUrl = await readCurrentPhotoUrl(member.id);

    const result = await updateMemberProfile({
      memberstackId: member.id,
      patch: {
        [MEMBER_FIELDS.profilePhotoUrl]: "",
        [MEMBER_FIELDS.profilePhoto]: [],
      },
    });

    // Best-effort cleanup of the previous blob (never blocks the response).
    await deleteBlobBestEffort(oldUrl, member.id);

    // Removing a required photo demotes an Active directory member to
    // Incomplete so the stored status never claims a photo is present.
    const storedStatus = String(
      result.record?.fields?.[MEMBER_FIELDS.memberDirectoryStatus] ?? ""
    ).trim();
    let directoryStatus: string | undefined;
    if (/^active$/i.test(storedStatus)) {
      directoryStatus = "Incomplete";
      await applyMemberDirectoryStatus({
        memberstackId: member.id,
        status: directoryStatus,
      });
    }

    console.error(
      JSON.stringify({
        event: "profile_photo_removed",
        memberstackId: member.id,
        airtableRecordId: result.record?.id ?? null,
        url: oldUrl || null,
        directoryStatus: directoryStatus ?? storedStatus,
      })
    );

    const profile = await recordToProfileDtoResolved(result.record);
    if (directoryStatus) profile.memberDirectoryStatus = directoryStatus;

    return withCors(
      NextResponse.json({
        success: true,
        directoryStatus: directoryStatus ?? storedStatus,
        profile,
      }),
      request
    );
  } catch (err) {
    if (err instanceof FormsError) {
      return withCors(
        NextResponse.json(
          { success: false, code: err.code, message: err.message },
          { status: err.status }
        ),
        request
      );
    }
    return withCors(
      NextResponse.json(
        {
          success: false,
          code: "INTERNAL_UNEXPECTED_ERROR",
          message: err instanceof Error ? err.message : "Could not remove photo",
        },
        { status: 500 }
      ),
      request
    );
  }
}
