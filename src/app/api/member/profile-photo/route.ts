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

const MAX_BYTES = 4 * 1024 * 1024; // 4MB (client optimizes to ~2MB; this is the hard guard)
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function extForType(contentType: string): string {
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  return "jpg";
}

function validateImageFile(
  file: File
): { ok: true; contentType: string; ext: string } | { ok: false; message: string } {
  const contentType = (file.type || "").toLowerCase();
  if (!ALLOWED_TYPES.has(contentType)) {
    return { ok: false, message: "Please upload a JPG, PNG or WebP image." };
  }
  if (file.size > MAX_BYTES) {
    return { ok: false, message: "Please choose an image under 4MB." };
  }
  return { ok: true, contentType, ext: extForType(contentType) };
}

/** Read the member's current full + thumbnail blob URLs (blank if none). */
async function readCurrentPhotoUrls(
  memberstackId: string
): Promise<{ full: string; thumb: string }> {
  const rows = await findMemberByMemberstackId(memberstackId);
  const f = rows[0]?.fields ?? {};
  const full =
    typeof f[MEMBER_FIELDS.profilePhotoUrl] === "string"
      ? (f[MEMBER_FIELDS.profilePhotoUrl] as string).trim()
      : "";
  const thumb =
    typeof f[MEMBER_FIELDS.profilePhotoThumbUrl] === "string"
      ? (f[MEMBER_FIELDS.profilePhotoThumbUrl] as string).trim()
      : "";
  return { full, thumb };
}

/** Best-effort blob deletion — never throws, never blocks the response. */
async function deleteBlobBestEffort(url: string, memberstackId: string): Promise<void> {
  if (!url) return;
  try {
    await del(url);
    console.error(
      JSON.stringify({ event: "profile_photo_blob_deleted", memberstackId, url })
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
 * Upload a member's profile photo (full + thumbnail) to Vercel Blob and write
 * the public URLs to the `Profile photo URL` and `Profile photo thumbnail URL`
 * fields. Old blobs are deleted best-effort.
 */
export async function POST(request: Request) {
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

    const form = await request.formData();
    const fullFile = form.get("full");
    const thumbFile = form.get("thumb");

    if (!(fullFile instanceof File)) {
      return withCors(
        NextResponse.json(
          { success: false, code: "PROFILE_VALIDATION_FAILED", message: "No photo file provided" },
          { status: 400 }
        ),
        request
      );
    }

    const fullValidation = validateImageFile(fullFile);
    if (!fullValidation.ok) {
      return withCors(
        NextResponse.json(
          { success: false, code: "PROFILE_VALIDATION_FAILED", message: fullValidation.message },
          { status: 400 }
        ),
        request
      );
    }

    // Thumbnail is optional: when omitted, the full image serves both roles
    // (tiny source images reuse a single blob).
    let thumbValidation: { ok: true; contentType: string; ext: string } | null = null;
    if (thumbFile !== null) {
      if (!(thumbFile instanceof File)) {
        return withCors(
          NextResponse.json(
            { success: false, code: "PROFILE_VALIDATION_FAILED", message: "Invalid thumbnail file" },
            { status: 400 }
          ),
          request
        );
      }
      const tv = validateImageFile(thumbFile);
      if (!tv.ok) {
        return withCors(
          NextResponse.json(
            { success: false, code: "PROFILE_VALIDATION_FAILED", message: tv.message },
            { status: 400 }
          ),
          request
        );
      }
      thumbValidation = tv;
    }

    const old = await readCurrentPhotoUrls(member.id);

    const fullBytes = Buffer.from(await fullFile.arrayBuffer());
    const fullBlob = await put(`profile-photos/${member.id}.${fullValidation.ext}`, fullBytes, {
      access: "public",
      contentType: fullValidation.contentType,
      addRandomSuffix: true,
    });

    let thumbUrl = fullBlob.url;
    if (thumbFile instanceof File && thumbValidation) {
      const thumbBytes = Buffer.from(await thumbFile.arrayBuffer());
      const thumbBlob = await put(
        `profile-photos/${member.id}-thumb.${thumbValidation.ext}`,
        thumbBytes,
        {
          access: "public",
          contentType: thumbValidation.contentType,
          addRandomSuffix: true,
        }
      );
      thumbUrl = thumbBlob.url;
    }

    const result = await updateMemberProfile({
      memberstackId: member.id,
      patch: {
        [MEMBER_FIELDS.profilePhotoUrl]: fullBlob.url,
        [MEMBER_FIELDS.profilePhotoThumbUrl]: thumbUrl,
      },
    });

    // Best-effort cleanup of the previous blobs (never blocks the response).
    const newUrls = new Set([fullBlob.url, thumbUrl]);
    for (const oldUrl of [old.full, old.thumb]) {
      if (oldUrl && !newUrls.has(oldUrl)) {
        await deleteBlobBestEffort(oldUrl, member.id);
      }
    }

    console.error(
      JSON.stringify({
        event: "profile_photo_uploaded",
        memberstackId: member.id,
        airtableRecordId: result.record?.id ?? null,
        fullUrl: fullBlob.url,
        thumbUrl,
        previous: { full: old.full || null, thumb: old.thumb || null },
        bytes: fullFile.size,
        contentType: fullValidation.contentType,
        shadowed: result.shadowed,
      })
    );

    return withCors(
      NextResponse.json({
        success: true,
        fullUrl: fullBlob.url,
        thumbUrl,
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
 * Remove the member's profile photo (clear both URL fields + delete blobs).
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

    const old = await readCurrentPhotoUrls(member.id);

    const result = await updateMemberProfile({
      memberstackId: member.id,
      patch: {
        [MEMBER_FIELDS.profilePhotoUrl]: "",
        [MEMBER_FIELDS.profilePhotoThumbUrl]: "",
      },
    });

    // Best-effort cleanup of both previous blobs (never blocks the response).
    await deleteBlobBestEffort(old.full, member.id);
    if (old.thumb && old.thumb !== old.full) {
      await deleteBlobBestEffort(old.thumb, member.id);
    }

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
        url: old.full || null,
        thumbUrl: old.thumb || null,
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
