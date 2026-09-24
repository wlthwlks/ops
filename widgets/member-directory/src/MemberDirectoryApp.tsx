import { useCallback, useEffect, useRef, useState } from "react";
import { widgetApi } from "../../shared/api";
import {
  logMemberstackDiagnostics,
  tryResolveSessionAccessToken,
} from "../../shared/memberstack-auth";
import { DirectoryHeader } from "./components/DirectoryHeader";
import { DirectoryClient } from "./components/DirectoryClient";
import type { DirectoryPage, DirectoryView, Member, Viewer } from "./lib/directory";

type Props = {
  apiBase: string;
  allowAnonymous?: boolean;
};

type Gate = "loading" | "ready" | "logged_out" | "error";

const PAGE_SIZE = 12;

export function MemberDirectoryApp({ apiBase, allowAnonymous }: Props) {
  const [gate, setGate] = useState<Gate>("loading");
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        logMemberstackDiagnostics("member_directory_mount");
        if (allowAnonymous) {
          if (!cancelled) {
            setToken(null);
            setGate("ready");
          }
          return;
        }
        const t = await tryResolveSessionAccessToken();
        if (cancelled) return;
        if (!t) {
          setGate("logged_out");
          return;
        }
        setToken(t);
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
  }, [allowAnonymous]);

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

  return <DirectoryExplorer apiBase={apiBase} token={token} />;
}

function DirectoryExplorer({
  apiBase,
  token,
}: {
  apiBase: string;
  token: string | null;
}) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<DirectoryView>("recommended");
  const [city, setCity] = useState("");
  const [field, setField] = useState("");

  const [members, setMembers] = useState<Member[]>([]);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [cities, setCities] = useState<string[]>([]);
  const [fields, setFields] = useState<Array<{ code: string; label: string }>>([]);
  const [page, setPage] = useState(1);

  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generationRef = useRef(0);

  const fetchDirectoryPage = useCallback(
    async (targetPage: number): Promise<DirectoryPage> => {
      const params = new URLSearchParams();
      params.set("page", String(targetPage));
      params.set("pageSize", String(PAGE_SIZE));
      params.set("view", view);
      if (query) params.set("q", query);
      if (city) params.set("city", city);
      if (field) params.set("field", field);

      const res = (await widgetApi(apiBase, `/api/directory?${params.toString()}`, {
        token: token || undefined,
      })) as DirectoryPage;
      return res;
    },
    [apiBase, token, query, city, field, view]
  );

  // Fetch page 1 whenever the filters change (or on mount).
  useEffect(() => {
    const generation = ++generationRef.current;
    let cancelled = false;
    setLoading(true);
    setError(null);

    void (async () => {
      try {
        const res = await fetchDirectoryPage(1);
        if (cancelled || generation !== generationRef.current) return;
        setMembers(res.members);
        setViewer(res.viewer);
        setTotal(res.total);
        setTotalPages(res.totalPages);
        setCities(res.cities);
        setFields(res.fields);
        setPage(1);
      } catch (e) {
        if (!cancelled && generation === generationRef.current) {
          setError(e instanceof Error ? e.message : "Could not load the directory");
        }
      } finally {
        if (!cancelled && generation === generationRef.current) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchDirectoryPage]);

  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    const generation = generationRef.current;
    const nextPage = page + 1;
    setLoadingMore(true);
    try {
      const res = await fetchDirectoryPage(nextPage);
      if (generation !== generationRef.current) return;
      setMembers((prev) => [...prev, ...res.members]);
      setPage(nextPage);
    } catch {
      /* ignore — keep the already-loaded results */
    } finally {
      if (generation === generationRef.current) setLoadingMore(false);
    }
  }, [loadingMore, page, fetchDirectoryPage]);

  return (
    <main className="min-h-dvh overflow-x-hidden">
      <DirectoryHeader
        total={total}
        cityCount={cities.length}
        fieldCount={fields.length}
        viewer={viewer}
      />
      <DirectoryClient
        query={query}
        view={view}
        city={city}
        field={field}
        cities={cities}
        fields={fields}
        members={members}
        total={total}
        totalPages={totalPages}
        loading={loading}
        loadingMore={loadingMore}
        error={error}
        onQueryChange={setQuery}
        onViewChange={setView}
        onCityChange={setCity}
        onFieldChange={setField}
        onLoadMore={loadMore}
      />
    </main>
  );
}
