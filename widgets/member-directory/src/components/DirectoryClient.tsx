import { useState } from "react";
import { Search, X, SlidersHorizontal } from "lucide-react";
import type { DirectoryView, Member } from "../lib/directory";
import { MemberCard } from "./MemberCard";
import { MemberDialog } from "./MemberDialog";

const VIEWS: { id: DirectoryView; label: string }[] = [
  { id: "recommended", label: "Recommended" },
  { id: "same-city", label: "Same city" },
  { id: "same-field", label: "Same field" },
  { id: "same-stage", label: "Same stage" },
  { id: "new", label: "New members" },
  { id: "all", label: "All members" },
];

type DirectoryClientProps = {
  query: string;
  view: DirectoryView;
  city: string;
  field: string;
  cities: string[];
  fields: Array<{ code: string; label: string }>;
  members: Member[];
  total: number;
  totalPages: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  onQueryChange: (q: string) => void;
  onViewChange: (v: DirectoryView) => void;
  onCityChange: (c: string) => void;
  onFieldChange: (f: string) => void;
  onLoadMore: () => void;
};

export function DirectoryClient(props: DirectoryClientProps) {
  const {
    query, view, city, field, cities, fields, members, total,
    loading, loadingMore, error,
    onQueryChange, onViewChange, onCityChange, onFieldChange, onLoadMore,
  } = props;

  const [selected, setSelected] = useState<Member | null>(null);

  const hasRefinements = query !== "" || view !== "recommended" || city !== "" || field !== "";
  const hasMore = members.length < total;

  const clearAll = () => {
    onQueryChange("");
    onViewChange("recommended");
    onCityChange("");
    onFieldChange("");
  };

  const selectClass =
    "w-full appearance-none rounded-full border border-border bg-transparent px-4 py-2.5 text-[13px] font-light text-foreground transition-colors hover:border-primary/50 focus:border-primary/60 focus:outline-none";

  return (
    <section className="mx-auto w-full min-w-0 max-w-6xl px-5 pb-24 sm:px-8">
      {/* Search */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <label htmlFor="member-search" className="sr-only">
          Search members by name, company, city or field
        </label>
        <input
          id="member-search"
          type="search"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search by name, company, city, field or what someone is working on"
          className="w-full appearance-none rounded-full border border-border bg-card/40 py-4 pl-12 pr-12 text-[15px] font-light text-foreground placeholder:text-muted-foreground/80 transition-colors hover:border-primary/40 focus:border-primary/60 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            aria-label="Clear search"
            className="absolute right-4 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-primary"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Quick views */}
      <div className="mt-6 flex flex-wrap gap-2">
        {VIEWS.map((v) => {
          const active = view === v.id;
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => onViewChange(v.id)}
              aria-pressed={active}
              className={`rounded-full border px-4 py-2 text-[12px] font-semibold uppercase tracking-brand transition-colors ${
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
              }`}
            >
              {v.label}
            </button>
          );
        })}
      </div>

      {/* Refine */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="filter-city" className="sr-only">
            Filter by city
          </label>
          <select
            id="filter-city"
            value={city}
            onChange={(e) => onCityChange(e.target.value)}
            className={selectClass}
          >
            <option value="">All cities</option>
            {cities.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="filter-field" className="sr-only">
            Filter by field
          </label>
          <select
            id="filter-field"
            value={field}
            onChange={(e) => onFieldChange(e.target.value)}
            className={selectClass}
          >
            <option value="">All fields</option>
            {fields.map((f) => (
              <option key={f.code} value={f.label}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Result meta */}
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-4">
        <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-brand text-muted-foreground">
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          {loading ? "Loading…" : `${total} ${total === 1 ? "member" : "members"}`}
          {view === "recommended" && !hasRefinements && !loading && " recommended for you"}
        </p>
        {hasRefinements && (
          <button
            type="button"
            onClick={clearAll}
            className="text-[12px] font-semibold uppercase tracking-brand text-primary transition-opacity hover:opacity-70"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Error */}
      {error && !loading && (
        <p className="mt-8 text-center text-[15px] font-light text-muted-foreground">{error}</p>
      )}

      {/* Grid */}
      {!loading && members.length > 0 && (
        <>
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-live="polite">
            {members.map((m) => (
              <MemberCard key={m.id} member={m} onSelect={setSelected} />
            ))}
          </div>

          {hasMore && (
            <div className="mt-10 flex justify-center">
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="rounded-full border border-border px-8 py-3 text-[13px] font-semibold uppercase tracking-brand text-foreground transition-colors hover:border-primary/60 hover:text-primary disabled:opacity-50"
              >
                {loadingMore ? "Loading…" : `Load more (${total - members.length} remaining)`}
              </button>
            </div>
          )}
        </>
      )}

      {/* Empty state */}
      {!loading && members.length === 0 && !error && (
        <div className="mt-16 text-center" aria-live="polite">
          <p className="text-lg font-normal uppercase tracking-brand text-foreground">
            No members match that yet
          </p>
          <p className="mx-auto mt-3 max-w-md text-pretty text-[15px] font-light leading-relaxed text-muted-foreground">
            Try a broader search, or clear your filters to see everyone in the community.
          </p>
          <button
            type="button"
            onClick={clearAll}
            className="mt-6 rounded-full border border-border px-6 py-3 text-[13px] font-semibold uppercase tracking-brand text-foreground transition-colors hover:border-primary/60 hover:text-primary"
          >
            Clear all filters
          </button>
        </div>
      )}

      <MemberDialog member={selected} onClose={() => setSelected(null)} />
    </section>
  );
}
