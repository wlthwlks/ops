const weeks = [
  {
    label: 'Week 1',
    title: 'Your introductions arrive',
    text: 'Meet the two founders selected for your monthly introduction and start the conversation.',
  },
  {
    label: 'Week 2',
    title: 'Connect virtually',
    text: 'Join a virtual session and meet founders beyond your usual circle.',
  },
  {
    label: 'Week 3',
    title: 'Walk with your city',
    text: 'Join your CITY WLKS and spend time with the women building businesses around you.',
  },
  {
    label: 'Week 4',
    title: 'Keep the momentum going',
    text: 'Reconnect through another virtual session and continue building relationships between walks.',
  },
]

export function MonthlyRhythm() {
  return (
    <section className="mx-auto w-full min-w-0 max-w-6xl px-5 sm:px-8">
      <div className="mb-10 flex flex-col gap-2 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-brand text-primary">
          What to expect
        </p>
        <h2 className="text-2xl font-bold uppercase tracking-tight text-foreground sm:text-3xl">
          There is something happening every week
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-pretty text-[15px] font-light leading-relaxed text-foreground">
          Your membership is designed around a simple monthly rhythm.
        </p>
      </div>

      <ol className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
        {weeks.map((w) => (
          <li key={w.label} className="flex h-full flex-col pt-5">
            <span
              className="mb-5 block h-px w-full bg-border"
              aria-hidden="true"
            />
            <span className="text-[11px] font-semibold uppercase tracking-brand text-primary">
              {w.label}
            </span>
            <h3 className="mt-2 text-base font-medium uppercase tracking-wide text-foreground">
              {w.title}
            </h3>
            <p className="mt-3 text-pretty text-[15px] font-light leading-relaxed text-foreground">
              {w.text}
            </p>
          </li>
        ))}
      </ol>

      <p className="mt-14 text-center text-lg font-normal uppercase tracking-brand text-foreground sm:text-xl">
        Introductions. Conversations. Walks.{' '}
        <span className="text-primary">Relationships. Repeat.</span>
      </p>
    </section>
  )
}
