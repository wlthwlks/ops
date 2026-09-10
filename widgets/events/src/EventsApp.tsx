import { useEffect, useRef, useState } from "react";

type Props = {
  /** Sweatpals community events embed script URL (with all query params). */
  embedSrc: string;
};

export function EventsApp({ embedSrc }: Props) {
  const embedRef = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = embedRef.current;
    if (!host) return;

    const script = document.createElement("script");
    script.src = embedSrc;
    script.async = true;
    script.onerror = () => setFailed(true);
    host.appendChild(script);

    // Sweatpals mounts its events UI (shadow root or iframe) next to the
    // script tag, inside this container. Treat any other child as "loaded".
    const observer = new MutationObserver(() => {
      if (Array.from(host.children).some((el) => el !== script)) {
        setLoaded(true);
        observer.disconnect();
      }
    });
    observer.observe(host, { childList: true });

    return () => {
      observer.disconnect();
      script.remove();
    };
  }, [embedSrc]);

  return (
    <main className="min-h-dvh overflow-x-hidden bg-background">
      <section className="relative">
        <div className="relative mx-auto flex max-w-4xl flex-col items-center justify-center px-5 pt-16 pb-12 text-center sm:px-8 sm:pt-24 sm:pb-16">
          <span className="animate-fade-up mb-6 inline-flex items-center gap-2 rounded-full border border-border/80 bg-background/40 px-4 py-1.5 text-[11px] font-medium uppercase tracking-brand text-muted-foreground backdrop-blur-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
            Events
          </span>
          <h1
            className="animate-fade-up text-balance text-3xl font-bold uppercase leading-[1.08] tracking-tight text-foreground sm:text-5xl"
            style={{ animationDelay: "0.08s" }}
          >
            Walks, socials &amp; gatherings near you
          </h1>
          <p
            className="animate-fade-up mt-5 max-w-xl text-pretty text-[15px] font-light leading-relaxed text-foreground/90 sm:text-base"
            style={{ animationDelay: "0.16s" }}
          >
            Browse everything happening across the community. Filter by city,
            type or date, then book your spot on a CITY WLK, virtual session or
            social in just a couple of taps.
          </p>
        </div>

        <div
          ref={embedRef}
          className="relative mx-auto max-w-[1120px] px-4 pb-20 sm:px-8"
        >
          {!loaded && !failed && (
            <div className="flex min-h-[40vh] items-center justify-center">
              <p className="animate-pulse text-sm font-light uppercase tracking-brand text-muted-foreground">
                Loading events…
              </p>
            </div>
          )}
          {failed && (
            <div className="flex min-h-[40vh] items-center justify-center">
              <p className="max-w-md text-center text-[15px] font-light leading-relaxed text-foreground/90">
                Events are taking a moment to load. Please refresh the page and
                try again.
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
