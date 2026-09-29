import { useEffect, useMemo, useState } from "react";
import { widgetApi } from "./api";
import { optimizeImageVariants } from "./image-optimize";
import { DIRECTORY_FIELD_LABELS, type DirectoryFieldKey } from "./directory";
import "./directory-join.css";

type RefData = {
  cities: Array<{ code: string; label: string; countryCode: string }>;
  industries: Array<{ code: string; label: string }>;
};

type Props = {
  apiBase: string;
  token: string | null;
  /** Directory-required fields the member still needs to fill in. */
  missingKeys: DirectoryFieldKey[];
  onJoined: () => void;
  onDismiss: () => void;
  title?: string;
  description?: string;
  /** Label for the secondary (dismiss) button. @default "Not right now" */
  secondaryLabel?: string;
};

const FIELD_ORDER: DirectoryFieldKey[] = [
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
];

export function DirectoryJoinModal({
  apiBase,
  token,
  missingKeys,
  onJoined,
  onDismiss,
  title = "We're launching the WLTH WLKS Member Directory 🎉",
  description = "Connect with amazing women entrepreneurs from around the world and let other members discover you and your business.",
  secondaryLabel = "Not right now",
}: Props) {
  const [checked, setChecked] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [instagramUrl, setInstagramUrl] = useState("");
  const [photoUrl, setPhotoUrl] = useState("");
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [refData, setRefData] = useState<RefData | null>(null);

  const missingSet = useMemo(() => new Set(missingKeys), [missingKeys]);
  const orderedKeys = useMemo(
    () => FIELD_ORDER.filter((k) => missingSet.has(k)),
    [missingSet]
  );

  useEffect(() => {
    let cancelled = false;
    void widgetApi(apiBase, "/api/reference-data/onboarding")
      .then((r) => {
        if (!cancelled) setRefData(r as unknown as RefData);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  const setValue = (k: string, v: string) =>
    setValues((prev) => ({ ...prev, [k]: v }));

  const onPhoto = async (file: File) => {
    if (!token || photoUploading) return;
    setPhotoUploading(true);
    setPhotoError("");
    try {
      const variants = await optimizeImageVariants(file);
      const fd = new FormData();
      fd.append("full", variants.full);
      if (!variants.same) fd.append("thumb", variants.thumb);
      const res = (await widgetApi(apiBase, "/api/member/profile-photo", {
        method: "POST",
        token,
        body: fd,
      })) as { fullUrl?: string };
      setPhotoUrl(typeof res.fullUrl === "string" ? res.fullUrl : "");
    } catch (e) {
      setPhotoError(e instanceof Error ? e.message : "Photo upload failed");
    } finally {
      setPhotoUploading(false);
    }
  };

  const stillMissing = useMemo(() => {
    return orderedKeys.filter((k) => {
      switch (k) {
        case "photo":
          return !photoUrl;
        case "firstName":
          return !(values.firstName || "").trim();
        case "lastName":
          return !(values.lastName || "").trim();
        case "professionalHeadline":
          return !(values.professionalHeadline || "").trim();
        case "profileBio":
          return !(values.profileBio || "").trim();
        case "businessName":
          return !(values.businessName || "").trim();
        case "location":
          return !(values.cityCode || "").trim();
        case "industry":
          return !(values.primaryIndustry || "").trim();
        case "businessWebsite":
          return !(values.businessWebsite || "").trim();
        case "socialLinks":
          return !linkedinUrl.trim() && !instagramUrl.trim();
        default:
          return false;
      }
    });
  }, [orderedKeys, values, photoUrl, linkedinUrl, instagramUrl]);

  const ready = checked && stillMissing.length === 0;

  const join = async () => {
    if (!token || !ready || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      const body: Record<string, unknown> = {
        memberDirectoryRequested: true,
        memberDirectoryInviteSeen: true,
      };
      if (missingSet.has("firstName")) body.firstName = values.firstName || "";
      if (missingSet.has("lastName")) body.lastName = values.lastName || "";
      if (missingSet.has("professionalHeadline"))
        body.professionalHeadline = values.professionalHeadline || "";
      if (missingSet.has("profileBio")) body.profileBio = values.profileBio || "";
      if (missingSet.has("businessName")) body.businessName = values.businessName || "";
      if (missingSet.has("businessWebsite"))
        body.businessWebsite = values.businessWebsite || "";
      if (missingSet.has("location")) {
        body.cityCode = values.cityCode || undefined;
        body.countryCode = values.countryCode || undefined;
      }
      if (missingSet.has("industry"))
        body.primaryIndustry = values.primaryIndustry || undefined;
      if (missingSet.has("socialLinks")) {
        body.socialLinks = [
          linkedinUrl.trim()
            ? { platform: "linkedin", url: linkedinUrl.trim() }
            : null,
          instagramUrl.trim()
            ? { platform: "instagram", url: instagramUrl.trim() }
            : null,
        ].filter((l): l is { platform: string; url: string } => Boolean(l));
      }

      await widgetApi(apiBase, "/api/member/profile", {
        method: "PATCH",
        token,
        body: JSON.stringify(body),
      });
      onJoined();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not join the directory");
    } finally {
      setSubmitting(false);
    }
  };

  const notNow = async () => {
    if (token) {
      try {
        await widgetApi(apiBase, "/api/member/profile", {
          method: "PATCH",
          token,
          body: JSON.stringify({ memberDirectoryInviteSeen: true }),
        });
      } catch {
        /* ignore */
      }
    }
    onDismiss();
  };

  return (
    <div className="wldj-overlay" role="dialog" aria-modal="true">
      <div className="wldj-card">
        <h3 className="wldj-title">
          {title}
        </h3>
        <p className="wldj-muted">
          {description}
        </p>
        <p className="wldj-muted">
          If you join, other members will see: your profile photo, first and last name,
          headline, bio, business name, location, industry, LinkedIn, website and social
          profiles.
        </p>

        <label className="wldj-check">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span>I want to be part of the WLTH WLKS Member Directory</span>
        </label>

        {checked && (
          <div className="wldj-form">
            {stillMissing.length > 0 && (
              <p className="wldj-hint">
                Complete the highlighted fields below to join the directory.
              </p>
            )}

            {orderedKeys.includes("photo") && (
              <div className="wldj-field">
                <label>Profile photo</label>
                <div className="wldj-photo">
                  {photoUrl ? (
                    <img src={photoUrl} alt="Profile" />
                  ) : null}
                  <div className="wldj-photo-actions">
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      disabled={photoUploading}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void onPhoto(f);
                        e.target.value = "";
                      }}
                    />
                    {photoUploading && (
                      <span className="wldj-muted">Uploading…</span>
                    )}
                  </div>
                </div>
                {photoError && <div className="wldj-banner-error">{photoError}</div>}
              </div>
            )}

            {orderedKeys.includes("firstName") && (
              <div className="wldj-field">
                <label>{DIRECTORY_FIELD_LABELS.firstName}</label>
                <input
                  value={values.firstName || ""}
                  onChange={(e) => setValue("firstName", e.target.value)}
                />
              </div>
            )}

            {orderedKeys.includes("lastName") && (
              <div className="wldj-field">
                <label>{DIRECTORY_FIELD_LABELS.lastName}</label>
                <input
                  value={values.lastName || ""}
                  onChange={(e) => setValue("lastName", e.target.value)}
                />
              </div>
            )}

            {orderedKeys.includes("professionalHeadline") && (
              <div className="wldj-field">
                <label>{DIRECTORY_FIELD_LABELS.professionalHeadline}</label>
                <input
                  placeholder="e.g. Founder & CEO, Brand Strategist"
                  value={values.professionalHeadline || ""}
                  onChange={(e) => setValue("professionalHeadline", e.target.value)}
                />
              </div>
            )}

            {orderedKeys.includes("profileBio") && (
              <div className="wldj-field">
                <label>{DIRECTORY_FIELD_LABELS.profileBio}</label>
                <textarea
                  rows={3}
                  placeholder="Tell other members a little about who you are and what you do."
                  value={values.profileBio || ""}
                  onChange={(e) => setValue("profileBio", e.target.value)}
                />
              </div>
            )}

            {orderedKeys.includes("businessName") && (
              <div className="wldj-field">
                <label>{DIRECTORY_FIELD_LABELS.businessName}</label>
                <input
                  placeholder="Your company or brand name"
                  value={values.businessName || ""}
                  onChange={(e) => setValue("businessName", e.target.value)}
                />
              </div>
            )}

            {orderedKeys.includes("location") && (
              <div className="wldj-field">
                <label>{DIRECTORY_FIELD_LABELS.location}</label>
                <select
                  value={values.cityCode || ""}
                  onChange={(e) => {
                    const code = e.target.value;
                    const city = (refData?.cities || []).find((c) => c.code === code);
                    setValues((prev) => ({
                      ...prev,
                      cityCode: code,
                      countryCode: city?.countryCode || "",
                    }));
                  }}
                >
                  <option value="">Select city</option>
                  {(refData?.cities || []).map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {orderedKeys.includes("industry") && (
              <div className="wldj-field">
                <label>{DIRECTORY_FIELD_LABELS.industry}</label>
                <select
                  value={values.primaryIndustry || ""}
                  onChange={(e) => setValue("primaryIndustry", e.target.value)}
                >
                  <option value="">Select industry</option>
                  {(refData?.industries || []).map((i) => (
                    <option key={i.code} value={i.code}>
                      {i.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {orderedKeys.includes("businessWebsite") && (
              <div className="wldj-field">
                <label>{DIRECTORY_FIELD_LABELS.businessWebsite}</label>
                <input
                  placeholder="yourbusiness.com"
                  value={values.businessWebsite || ""}
                  onChange={(e) => setValue("businessWebsite", e.target.value)}
                />
              </div>
            )}

            {orderedKeys.includes("socialLinks") && (
              <div className="wldj-field">
                <label className="wldj-label-sm">
                  {DIRECTORY_FIELD_LABELS.socialLinks}
                </label>
                <input
                  placeholder="LinkedIn URL"
                  value={linkedinUrl}
                  onChange={(e) => setLinkedinUrl(e.target.value)}
                />
                <input
                  style={{ marginTop: 8 }}
                  placeholder="Instagram URL"
                  value={instagramUrl}
                  onChange={(e) => setInstagramUrl(e.target.value)}
                />
              </div>
            )}
          </div>
        )}

        {error && <div className="wldj-banner-error">{error}</div>}

        <div className="wldj-actions">
          <button
            type="button"
            className="wldj-btn wldj-btn-primary"
            disabled={!ready || submitting}
            onClick={() => void join()}
          >
            {submitting ? "Joining…" : "Join Directory"}
          </button>
          <button
            type="button"
            className="wldj-btn wldj-btn-secondary"
            onClick={() => void notNow()}
          >
            {secondaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
