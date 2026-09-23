import { MapPin } from "lucide-react";
import type { Member } from "../lib/directory";

type MemberCardProps = {
  member: Member;
  onSelect: (member: Member) => void;
};

export function MemberCard({ member, onSelect }: MemberCardProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(member)}
      aria-label={`View full profile for ${member.name}`}
      className="group flex h-full w-full flex-col rounded-2xl border border-border/70 bg-card/40 p-6 text-left transition-colors hover:border-primary/50 hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="flex items-start gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={member.photo}
          alt={`${member.name}${member.role ? `, ${member.role}` : ""}`}
          className="size-14 shrink-0 rounded-full object-cover"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="truncate text-base font-medium text-foreground">
              {member.name}
            </h3>
            {member.isNew && (
              <span className="shrink-0 rounded-full border border-primary/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-brand text-primary">
                New
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate text-[13px] font-light text-muted-foreground">
            {member.role}
            {member.role && member.company ? ", " : ""}
            {member.company}
          </p>
          <a
            href={`mailto:${member.email}`}
            onClick={(e) => e.stopPropagation()}
            className="mt-1 block truncate text-[13px] font-light text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-primary hover:decoration-primary"
          >
            {member.email}
          </a>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] font-semibold uppercase tracking-brand">
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <MapPin className="size-3" aria-hidden="true" />
          {member.city}
        </span>
        {member.field && <span className="text-primary">{member.field}</span>}
      </div>

      <p
        className="relative mt-4 max-h-[5.25rem] overflow-hidden text-[14px] font-light leading-relaxed text-muted-foreground"
        style={{
          maskImage:
            "linear-gradient(to bottom, black 0, black 45%, transparent 100%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, black 0, black 45%, transparent 100%)",
        }}
      >
        {member.bio || "—"}
      </p>

      <span className="mt-4 text-[11px] font-semibold uppercase tracking-brand text-muted-foreground transition-colors group-hover:text-primary">
        View full profile
      </span>
    </button>
  );
}
