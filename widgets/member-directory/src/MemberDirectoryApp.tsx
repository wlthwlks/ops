import { useEffect, useState } from "react";
import { widgetApi } from "../../shared/api";
import {
  logMemberstackDiagnostics,
  tryResolveSessionAccessToken,
} from "../../shared/memberstack-auth";
import { DirectoryHeader } from "./components/DirectoryHeader";
import { DirectoryClient } from "./components/DirectoryClient";
import {
  mapMember,
  viewerFromProfile,
  type DirectoryMemberDto,
  type Member,
  type RefData,
  type Viewer,
} from "./lib/directory";

type Props = {
  apiBase: string;
  allowAnonymous?: boolean;
};

type Gate = "loading" | "ready" | "logged_out" | "error";

export function MemberDirectoryApp({ apiBase, allowAnonymous }: Props) {
  const [gate, setGate] = useState<Gate>("loading");
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [viewer, setViewer] = useState<Viewer | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        logMemberstackDiagnostics("member_directory_mount");
        let token: string | null = null;
        if (!allowAnonymous) {
          token = await tryResolveSessionAccessToken();
          if (!token) {
            if (!cancelled) setGate("logged_out");
            return;
          }
        }

        const ref = (await widgetApi(
          apiBase,
          "/api/reference-data/onboarding"
        )) as unknown as RefData;

        const [profileRes, dirRes] = await Promise.all([
          token
            ? (widgetApi(apiBase, "/api/member/profile", { token }) as Promise<Record<string, unknown>>)
            : Promise.resolve({ profile: null } as Record<string, unknown>),
          token
            ? (widgetApi(apiBase, "/api/directory", { token }) as Promise<Record<string, unknown>>)
            : Promise.resolve({ members: [] } as Record<string, unknown>),
        ]);

        if (cancelled) return;

        const dtos = (dirRes.members || []) as DirectoryMemberDto[];
        setMembers(dtos.map((d) => mapMember(d, ref)));

        const profile = profileRes.profile as
          | { name?: string; city?: string; primaryIndustry?: string; businessStage?: string }
          | undefined
          | null;
        setViewer(
          profile
            ? viewerFromProfile(
                {
                  name: String(profile.name ?? ""),
                  city: String(profile.city ?? ""),
                  primaryIndustry: String(profile.primaryIndustry ?? ""),
                  businessStage: String(profile.businessStage ?? ""),
                },
                ref
              )
            : null
        );

        setGate("ready");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not load the directory");
          setGate("error");
        }
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
          Loading the directory…
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
          Log in with your WLTH WLKS Memberstack account to browse the Member Directory.
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
      <DirectoryHeader members={members} viewer={viewer} />
      <DirectoryClient members={members} viewer={viewer} />
    </main>
  );
}
