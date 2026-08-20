import { useEffect, useState } from "react";
import {
  logMemberstackDiagnostics,
  tryResolveSessionAccessToken,
} from "../../shared/memberstack-auth";
import { GsHero } from "./components/GsHero";
import { MonthlyRhythm } from "./components/MonthlyRhythm";
import { MembershipPillars } from "./components/MembershipPillars";
import { MembershipTips } from "./components/MembershipTips";
import { CommunityGuidelines } from "./components/CommunityGuidelines";
import { FaqSection } from "./components/FaqSection";
import { ClosingCta } from "./components/ClosingCta";
import { SiteFooter } from "./components/SiteFooter";

type Props = {
  /** When true, skip Memberstack gate (for local preview only). */
  allowAnonymous?: boolean;
};

type Gate = "loading" | "authed" | "logged_out" | "error";

export function GettingStartedApp(props: Props) {
  const [gate, setGate] = useState<Gate>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (props.allowAnonymous) {
        if (!cancelled) setGate("authed");
        return;
      }
      try {
        logMemberstackDiagnostics("getting_started_mount");
        const token = await tryResolveSessionAccessToken();
        if (cancelled) return;
        setGate(token ? "authed" : "logged_out");
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not verify membership");
        setGate("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.allowAnonymous]);

  if (gate === "loading") {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-5 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-brand text-primary">
          WLTH WLKS
        </p>
        <p className="text-[15px] font-light text-muted-foreground">
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
        <p className="max-w-md text-[15px] font-light leading-relaxed text-muted-foreground">
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
        <p className="max-w-md text-[15px] font-light leading-relaxed text-muted-foreground">
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
    </main>
  );
}
