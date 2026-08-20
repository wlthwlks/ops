const HERO_IMG =
  'https://framerusercontent.com/images/ZWx0YzGf2TsVqPekBx6y2yTfWnc.jpg?width=1200&height=675'

export function GsHero() {
  return (
    <section className="relative overflow-hidden">
      <div className="absolute inset-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={HERO_IMG || '/placeholder.svg'}
          alt=""
          aria-hidden="true"
          className="size-full object-cover object-[center_30%]"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-background/55 via-background/78 to-background" />
        <div className="absolute inset-0 grain opacity-60" />
      </div>

      <div className="relative mx-auto flex min-h-[62vh] max-w-4xl flex-col items-center justify-center px-5 py-24 text-center sm:min-h-[68vh] sm:px-8">
        <span className="animate-fade-up mb-6 inline-flex items-center gap-2 rounded-full border border-border/80 bg-background/40 px-4 py-1.5 text-[11px] font-medium uppercase tracking-brand text-muted-foreground backdrop-blur-sm">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
          Member Portal
        </span>
        <h1
          className="animate-fade-up text-balance text-4xl font-bold uppercase leading-[1.05] tracking-tight text-foreground sm:text-6xl"
          style={{ animationDelay: '0.08s' }}
        >
          Getting started with WLTH <span className="text-primary">WLKS</span>
        </h1>
        <p
          className="animate-fade-up mt-6 max-w-xl text-pretty text-lg font-light leading-relaxed text-foreground/90 sm:text-xl"
          style={{ animationDelay: '0.16s' }}
        >
          You&apos;re in. Now make the most of your membership.
        </p>
        <p
          className="animate-fade-up mt-5 max-w-2xl text-pretty text-[15px] font-light leading-relaxed text-muted-foreground sm:text-base"
          style={{ animationDelay: '0.22s' }}
        >
          WLTH WLKS is a global community for ambitious female founders who are
          done building alone. Your membership gives you curated founder
          introductions, monthly City WLTH WLKS, virtual networking sessions, a
          global community, and access to women building businesses across
          industries, stages and cities around the world.
        </p>
        <p
          className="animate-fade-up mt-6 text-sm font-normal uppercase tracking-brand text-primary"
          style={{ animationDelay: '0.28s' }}
        >
          There&apos;s always a reason to connect, and getting started is simple.
        </p>
      </div>
    </section>
  )
}
