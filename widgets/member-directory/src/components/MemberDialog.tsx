import { useEffect, useRef } from "react";
import { X, MapPin, Mail, Briefcase, CalendarDays, Globe } from "lucide-react";
import type { Member } from "../lib/directory";

function LinkedinIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.85-3.04-1.85 0-2.13 1.45-2.13 2.94v5.67H9.36V9h3.41v1.56h.05c.47-.9 1.63-1.85 3.36-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.55C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z" />
    </svg>
  );
}

type MemberDialogProps = {
  member: Member | null;
  onClose: () => void;
};

export function MemberDialog({ member, onClose }: MemberDialogProps) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!member) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [member, onClose]);

  if (!member) return null;

  const cityCountry = [member.city, member.country].filter(Boolean).join(", ");

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center">
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close profile"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-background/80 backdrop-blur-sm"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-dialog-name"
        className="animate-fade-up relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border border-border bg-card p-6 sm:rounded-3xl sm:p-9"
      >
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close profile"
          className="absolute right-5 top-5 flex size-9 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:border-primary/60 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-4" aria-hidden="true" />
        </button>

        <div className="flex flex-col gap-5 pr-10 sm:flex-row sm:items-center sm:gap-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={member.photoFull}
            alt={`${member.name}${member.role ? `, ${member.role}` : ""}`}
            className="size-20 shrink-0 rounded-full object-cover sm:size-24"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h2
                id="member-dialog-name"
                className="text-2xl font-bold uppercase tracking-tight text-foreground"
              >
                {member.name}
              </h2>
              {member.isNew && (
                <span className="rounded-full border border-primary/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-brand text-primary">
                  New member
                </span>
              )}
            </div>
            <p className="mt-1 text-[15px] font-light text-muted-foreground">
              {member.role}
              {member.role && member.company ? ", " : ""}
              {member.company}
            </p>
            <a
              href={`mailto:${member.email}`}
              className="mt-2 inline-flex items-center gap-2 text-[14px] font-light text-foreground underline decoration-border underline-offset-4 transition-colors hover:text-primary hover:decoration-primary"
            >
              <Mail className="size-3.5" aria-hidden="true" />
              {member.email}
            </a>
          </div>
        </div>

        {/* Facts */}
        <dl className="mt-7 grid grid-cols-2 gap-x-6 gap-y-5 border-y border-border/70 py-6 sm:grid-cols-4">
          {[
            { icon: MapPin, label: "City", value: cityCountry || "—" },
            { icon: Briefcase, label: "Field", value: member.field || "—" },
            { icon: Briefcase, label: "Stage", value: member.stage || "—" },
            {
              icon: CalendarDays,
              label: "Member since",
              value: member.joinedLabel.replace("Joined ", "") || "—",
            },
          ].map((fact) => (
            <div key={fact.label}>
              <dt className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-brand text-primary">
                <fact.icon className="size-3" aria-hidden="true" />
                {fact.label}
              </dt>
              <dd className="mt-1.5 text-[14px] font-light leading-relaxed text-foreground">
                {fact.value}
              </dd>
            </div>
          ))}
        </dl>

        {/* Bio */}
        <div className="mt-7">
          <h3 className="text-[11px] font-semibold uppercase tracking-brand text-muted-foreground">
            About
          </h3>
          <p className="mt-3 text-pretty text-[15px] font-light leading-relaxed text-muted-foreground">
            {member.bio || "—"}
          </p>
        </div>

        {/* Open to */}
        {member.openTo && (
          <div className="mt-7">
            <h3 className="text-[11px] font-semibold uppercase tracking-brand text-muted-foreground">
              Open to
            </h3>
            <div className="mt-3 flex flex-wrap gap-2">
              <span className="rounded-full border border-border px-3 py-1 text-[12px] font-light text-foreground">
                {member.openTo}
              </span>
            </div>
          </div>
        )}

        <div className="mt-7 grid gap-6 border-t border-border/70 pt-6 sm:grid-cols-2">
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-brand text-primary">
              Looking for
            </h3>
            <p className="mt-2.5 text-pretty text-[14px] font-light leading-relaxed text-muted-foreground">
              {member.lookingFor}
            </p>
          </div>
          <div>
            <h3 className="text-[11px] font-semibold uppercase tracking-brand text-primary">
              Happy to help with
            </h3>
            <p className="mt-2.5 text-pretty text-[14px] font-light leading-relaxed text-muted-foreground">
              {member.offering}
            </p>
          </div>
        </div>

        {/* Links */}
        {(member.website || member.linkedin) && (
          <div className="mt-7 border-t border-border/70 pt-6">
            <h3 className="text-[11px] font-semibold uppercase tracking-brand text-muted-foreground">
              Links
            </h3>
            <div className="mt-3 flex flex-wrap gap-3">
              {member.website && (
                <a
                  href={member.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-[12px] font-light text-foreground transition-colors hover:border-primary/60 hover:text-primary"
                >
                  <Globe className="size-3.5" aria-hidden="true" />
                  Website
                </a>
              )}
              {member.linkedin && (
                <a
                  href={member.linkedin}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-[12px] font-light text-foreground transition-colors hover:border-primary/60 hover:text-primary"
                >
                  <LinkedinIcon className="size-3.5" />
                  LinkedIn
                </a>
              )}
            </div>
          </div>
        )}

        <div className="mt-8 flex flex-wrap gap-3">
          <a
            href={`mailto:${member.email}`}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-6 py-3 text-[13px] font-semibold uppercase tracking-brand text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Mail className="size-4" aria-hidden="true" />
            Reach out
          </a>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-border px-6 py-3 text-[13px] font-semibold uppercase tracking-brand text-foreground transition-colors hover:border-primary/60 hover:text-primary"
          >
            Back to directory
          </button>
        </div>
      </div>
    </div>
  );
}
