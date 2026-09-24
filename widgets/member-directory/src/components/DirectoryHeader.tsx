import type { Viewer } from "../lib/directory";

type DirectoryHeaderProps = {
  total: number;
  cityCount: number;
  fieldCount: number;
  viewer: Viewer | null;
};

export function DirectoryHeader({
  total,
  cityCount,
  fieldCount,
  viewer,
}: DirectoryHeaderProps) {
  return (
    <section className="mx-auto w-full min-w-0 max-w-6xl px-5 pb-10 pt-20 sm:px-8 sm:pb-14 sm:pt-24">
      <p className="animate-fade-up text-[11px] font-semibold uppercase tracking-brand text-primary">
        Member Directory
      </p>
      <h1
        className="animate-fade-up mt-4 text-balance text-4xl font-bold uppercase leading-[1.05] tracking-tight text-foreground sm:text-5xl"
        style={{ animationDelay: "0.06s" }}
      >
        Find the women <span className="text-primary">building alongside you</span>
      </h1>
      <p
        className="animate-fade-up mt-5 max-w-2xl text-pretty text-[15px] font-light leading-relaxed text-muted-foreground sm:text-base"
        style={{ animationDelay: "0.12s" }}
      >
        Search the community by name, city, field or what someone is working on
        right now. Every profile shows what that founder is looking for and what
        she is happy to help with, so you always have a reason to reach out.
      </p>

      <dl
        className="animate-fade-up mt-10 grid max-w-2xl grid-cols-3 gap-6 border-t border-border/70 pt-6"
        style={{ animationDelay: "0.18s" }}
      >
        {[
          { label: "Members", value: total },
          { label: "Cities", value: cityCount },
          { label: "Fields", value: fieldCount },
        ].map((stat) => (
          <div key={stat.label}>
            <dt className="text-[10px] font-semibold uppercase tracking-brand text-muted-foreground">
              {stat.label}
            </dt>
            <dd className="mt-1 font-mono text-2xl tabular-nums text-foreground">
              {stat.value}
            </dd>
          </div>
        ))}
      </dl>

      {viewer && (viewer.city || viewer.field) && (
        <p
          className="animate-fade-up mt-8 text-[12px] font-light uppercase tracking-brand text-muted-foreground"
          style={{ animationDelay: "0.24s" }}
        >
          Recommendations are based on your profile in {viewer.city}
          {viewer.field ? ` and ${viewer.field}` : ""}
        </p>
      )}
    </section>
  );
}
