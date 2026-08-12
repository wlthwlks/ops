import { useEffect, useState } from "react";
import {
  logMemberstackDiagnostics,
  tryResolveSessionAccessToken,
} from "../../shared/memberstack-auth";
import { GsHero } from "./components/GsHero";
import { MembershipPillars } from "./components/MembershipPillars";
import { MonthlyRhythm } from "./components/MonthlyRhythm";
import { CommunitySection } from "./components/CommunitySection";
import { MembershipTips } from "./components/MembershipTips";
import { MemberDirectory } from "./components/MemberDirectory"; // Temporarily hidden
import { ClosingCta } from "./components/ClosingCta";
import { SiteFooter } from "./components/SiteFooter";

type Props = {
  /** Optional Member Directory CTA URL from data-directory-url — Temporarily hidden */
  // directoryUrl?: string;
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
      <div className="gs-gate">
        <p className="gs-kicker">WLTH WLKS</p>
        <p>Loading your membership…</p>
      </div>
    );
  }

  if (gate === "logged_out") {
    return (
      <div className="gs-gate">
        <h2>Members only</h2>
        <p>
          Log in with your WLTH WLKS Memberstack account to view Getting Started and make
          the most of your membership.
        </p>
      </div>
    );
  }

  if (gate === "error") {
    return (
      <div className="gs-gate">
        <h2>Something went wrong</h2>
        <p>{error || "Please refresh and try again."}</p>
      </div>
    );
  }

  return (
    <main className="gs-main">
      <GsHero />
      <div className="gs-stack">
        <MembershipPillars />
        <MonthlyRhythm />
        <CommunitySection />
        <MembershipTips />
        {/* <MemberDirectory directoryUrl={props.directoryUrl} /> Temporarily hidden */}
        <ClosingCta />
      </div>
      <SiteFooter />
    </main>
  );
}
