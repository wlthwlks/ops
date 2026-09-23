import { useMemo, useState } from "react";
import { Search, X, SlidersHorizontal } from "lucide-react";
import type { Member, Viewer } from "../lib/directory";
import { MemberCard } from "./MemberCard";
import { MemberDialog } from "./MemberDialog";

type View =
  | "recommended"
  | "same-city"
  | "same-field"
  | "same-stage"
  | "new"
  | "all";

const VIEWS: { id: View; label: string }[] = [
  { id: "recommended", label: "Recommended" },
  { id: "same-city", label: "Same city" },
  { id: "same-field", label: "Same field" },
  { id: "same-stage", label: "Same stage" },
  { id: "new", label: "New members" },
  { id: "all", label: "All members" },
];

function score(member: Member, viewer: Viewer | null) {
  if (!viewer) return 0;
  let s = 0;
  if (member.city === viewer.city) s += 4;
  if (member.field === viewer.field) s += 3;
  if (member.stage === viewer.stage) s += 2;
  if (member.isNew) s += 1;
  return s;
}

type DirectoryClientProps = {
  members: Member[];
  viewer: Viewer | null;
};

export function DirectoryClient({ members, viewer }: DirectoryClientProps) {
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("recommended");
  const [city, setCity] = useState("all");
  const [field, setField] = useState("all");
  const [selected, setSelected] = useState<Member | null>(null);

  const cities = useMemo(
    () => [...new Set(members.map((m) => m.city).filter(Boolean))].sort(),
    [members]
  );
  const fields = useMemo(
    () => [...new Set(members.map((m) => m.field).filter(Boolean))].sort(),
    [members]
  );

  const hasRefinements =
    query !== "" ||
    view !== "recommended" ||
    city !== "all" ||
    field !== "all";

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();

    const filtered = members.filter((m) => {
      if (view === "same-city" && m.city !== viewer?.city) return false;
      if (view === "same-field" && m.field !== viewer?.field) return false;
      if (view === "same-stage" && m.stage !== viewer?.stage) return false;
      if (view === "new" && !m.isNew) return false;

      if (city !== "all" && m.city !== city) return false;
      if (field !== "all" && m.field !== field) return false;

      if (q) {
        const haystack = [
          m.name,
          m.email,
          m.role,
          m.company,
          m.city,
          m.country,
          m.field,
          m.stage,
          m.bio,
          m.lookingFor,
          m.offering,
          m.openTo,
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }

      return true;
    });

    if (view === "recommended") {
      return [...filtered].sort(
        (a, b) =>
          score(b, viewer) - score(a, viewer) || a.name.localeCompare(b.name)
      );
    }
    if (view === "new") {
      return [...filtered].sort((a, b) => b.joined.localeCompare(a.joined));
    }
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  }, [members, viewer, query, view, city, field]);

  const clearAll = () => {
    setQuery("");
    setView("recommended");
    setCity("all");
    setField("all");
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
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, company, city, field or what someone is working on"
          className="w-full appearance-none rounded-full border border-border bg-card/40 py-4 pl-12 pr-12 text-[15px] font-light text-foreground placeholder:text-muted-foreground/80 transition-colors hover:border-primary/40 focus:border-primary/60 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
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
              onClick={() => setView(v.id)}
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
            onChange={(e) => setCity(e.target.value)}
            className={selectClass}
          >
            <option value="all">All cities</option>
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
            onChange={(e) => setField(e.target.value)}
            className={selectClass}
          >
            <option value="all">All fields</option>
            {fields.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Result meta */}
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-4">
        <p className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-brand text-muted-foreground">
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          {results.length} {results.length === 1 ? "member" : "members"}
          {view === "recommended" && !hasRefinements && " recommended for you"}
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

      {/* Grid */}
      {results.length > 0 ? (
        <div
          className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
          aria-live="polite"
        >
          {results.map((m) => (
            <MemberCard key={m.id} member={m} onSelect={setSelected} />
          ))}
        </div>
      ) : (
        <div className="mt-16 text-center" aria-live="polite">
          <p className="text-lg font-normal uppercase tracking-brand text-foreground">
            No members match that yet
          </p>
          <p className="mx-auto mt-3 max-w-md text-pretty text-[15px] font-light leading-relaxed text-muted-foreground">
            Try a broader search, or clear your filters to see everyone in the
            community.
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
