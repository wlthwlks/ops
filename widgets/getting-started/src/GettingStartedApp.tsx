import { useEffect, useState } from "react";
import {
  logMemberstackDiagnostics,
  tryResolveSessionAccessToken,
} from "../../shared/memberstack-auth";
import { widgetApi } from "../../shared/api";
import {
  computeMissingDirectoryFields,
  type DirectoryFieldKey,
} from "../../shared/directory";
import { DirectoryJoinModal } from "../../shared/DirectoryJoinModal";
import { GsHero } from "./components/GsHero";
import { MonthlyRhythm } from "./components/MonthlyRhythm";
import { MembershipPillars } from "./components/MembershipPillars";
import { MembershipTips } from "./components/MembershipTips";
import { CommunityGuidelines } from "./components/CommunityGuidelines";
import { FaqSection } from "./components/FaqSection";
import { ClosingCta } from "./components/ClosingCta";
import { SiteFooter } from "./components/SiteFooter";

type Props = {
  apiBase: string;
  /** When true, skip Memberstack gate (for local preview only). */
  allowAnonymous?: boolean;
};

type Gate = "loading" | "authed" | "logged_out" | "error";

export function GettingStartedApp({ apiBase, allowAnonymous }: Props) {
  const [gate, setGate] = useState<Gate>("loading");
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [missingKeys, setMissingKeys] = useState<DirectoryFieldKey[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (allowAnonymous) {
        if (!cancelled) setGate("authed");
        return;
      }
      try {
        logMemberstackDiagnostics("getting_started_mount");
        const t = await tryResolveSessionAccessToken();
        if (cancelled) return;
        if (!t) {
          setGate("logged_out");
          return;
        }
        setToken(t);

        try {
          const [cfg, profileRes] = await Promise.all([
            widgetApi(apiBase, "/api/forms/config"),
            widgetApi(apiBase, "/api/member/profile", { token: t }),
          ]);
          if (cancelled) return;
          const directoryEnabled = Boolean(
            (cfg as { flags?: { directoryEnabled?: boolean } }).flags
              ?.directoryEnabled
          );
          const p = ((profileRes as { profile?: Record<string, unknown> }).profile ||
            {}) as Record<string, unknown>;
          const seen = p.memberDirectoryInviteSeen === true;
          const status = String(p.memberDirectoryStatus || "").trim();
          const optedIn = /^(active|incomplete)$/i.test(status);

          if (directoryEnabled && !seen && !optedIn) {
            setMissingKeys(
              computeMissingDirectoryFields({
                profilePhotoUrls: Array.isArray(p.profilePhoto)
                  ? (p.profilePhoto as string[])
                  : [],
                firstName: String(p.firstName || ""),
                lastName: String(p.lastName || ""),
                professionalHeadline: String(p.professionalHeadline || ""),
                profileBio: String(p.profileBio || ""),
                businessName: String(p.businessName || ""),
                cityCode: String(p.cityCode || ""),
                city: String(p.city || ""),
                primaryIndustry: String(p.primaryIndustry || ""),
                businessWebsite: String(p.businessWebsite || ""),
                socialLinks: Array.isArray(p.socialLinks)
                  ? (p.socialLinks as Array<{ platform: string; url: string }>)
                  : [],
              })
            );
            setShowInvite(true);
          }
        } catch {
          /* directory invite is optional — never block the page on it */
        }

        if (!cancelled) setGate("authed");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not verify membership");
        setGate("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [apiBase, allowAnonymous]);

  if (gate === "loading") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-5 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-brand text-primary">
          WLTH WLKS
        </p>
        <p className="text-[15px] font-light text-foreground">
          Loading your membership…
        </p>
      </div>
    );
  }

  if (gate === "logged_out") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-5 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-brand text-primary">
          WLTH WLKS
        </p>
        <h2 className="text-2xl font-bold uppercase tracking-tight text-foreground">
          Members only
        </h2>
        <p className="max-w-md text-[15px] font-light leading-relaxed text-foreground">
          Log in with your WLTH WLKS Memberstack account to view Getting Started and make
          the most of your membership.
        </p>
      </div>
    );
  }

  if (gate === "error") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-5 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-brand text-primary">
          WLTH WLKS
        </p>
        <h2 className="text-2xl font-bold uppercase tracking-tight text-foreground">
          Something went wrong
        </h2>
        <p className="max-w-md text-[15px] font-light leading-relaxed text-foreground">
          {error || "Please refresh and try again."}
        </p>
      </div>
    );
  }

  return (
    <main className="min-h-dvh overflow-x-hidden">
      <GsHero />
      <div className="flex flex-col gap-20 py-20 sm:gap-28 sm:py-28">
        <MonthlyRhythm />
        <MembershipPillars />
        <MembershipTips />
        <CommunityGuidelines />
        <FaqSection />
        <ClosingCta />
      </div>
      <SiteFooter />

      {showInvite && (
        <DirectoryJoinModal
          apiBase={apiBase}
          token={token}
          missingKeys={missingKeys}
          onJoined={() => setShowInvite(false)}
          onDismiss={() => setShowInvite(false)}
        />
      )}
    </main>
  );
}
