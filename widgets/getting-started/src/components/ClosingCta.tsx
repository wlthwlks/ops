export function ClosingCta() {
  return (
    <section className="mx-auto w-full min-w-0 max-w-4xl px-5 sm:px-8">
      <div className="relative pt-14 text-center">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 mx-auto h-px w-40 bg-gradient-to-r from-transparent via-primary to-transparent"
          aria-hidden="true"
        />
        <h2 className="text-balance text-3xl font-bold uppercase leading-[1.05] tracking-tight text-foreground sm:text-4xl md:text-5xl">
          You don&apos;t have to <span className="text-primary">build alone.</span>
        </h2>

        <div className="mx-auto mt-8 flex max-w-2xl flex-col gap-4">
          <p className="text-pretty text-[15px] font-light leading-relaxed text-muted-foreground sm:text-base">
            Your next introduction could become a collaborator.
          </p>
          <p className="text-pretty text-[15px] font-light leading-relaxed text-muted-foreground sm:text-base">
            Your next walk could solve a problem you&apos;ve been stuck on for
            weeks.
          </p>
          <p className="text-pretty text-[15px] font-light leading-relaxed text-muted-foreground sm:text-base">
            Your next conversation could introduce you to an opportunity you
            never knew existed.
          </p>
        </div>

        <p className="mx-auto mt-8 max-w-2xl text-pretty text-base font-light leading-relaxed text-foreground sm:text-lg">
          That&apos;s the value of WLTH WLKS: being surrounded by ambitious women
          who understand what it takes to build something of your own.
        </p>

        <p className="mt-8 text-sm font-light uppercase tracking-brand text-muted-foreground">
          Keep your profile updated. Show up. Start conversations.
        </p>
        <p className="mt-4 text-lg font-normal uppercase tracking-brand text-foreground sm:text-xl">
          We&apos;ll help make the introductions.
        </p>
      </div>
    </section>
  )
}
