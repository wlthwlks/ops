const tips = [
  {
    title: 'Keep your profile current.',
    text: 'Your business changes. Your goals change. Updating your profile helps us make more relevant introductions.',
  },
  {
    title: 'Reply to your introductions.',
    text: 'A simple hello can turn into a collaborator, client, mentor, referral partner or close friend.',
  },
  {
    title: 'Show up when you can.',
    text: 'Join your CITY WLKS and virtual sessions. Relationships become more valuable the more often you see the same people.',
  },
  {
    title: 'Be useful.',
    text: 'Tell other founders what you know, who you can introduce and where you can help. Strong networks work in both directions.',
  },
  {
    title: 'Follow the connection.',
    text: 'Not every valuable conversation needs an immediate business outcome. Some of the best relationships start with simply meeting someone who understands what you’re building.',
  },
]

export function MembershipTips() {
  return (
    <section className="mx-auto w-full min-w-0 max-w-5xl px-5 sm:px-8">
      <div className="mb-10 flex flex-col gap-2 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-brand text-primary">
          Make it count
        </p>
        <h2 className="text-2xl font-bold uppercase tracking-tight text-foreground sm:text-3xl">
          Getting the most from WLTH WLKS
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-pretty text-[15px] font-light leading-relaxed text-foreground">
          The members who get the most value are the ones who participate.
        </p>
      </div>

      <div className="mx-auto max-w-3xl divide-y divide-border/70 border-y border-border/70">
        {tips.map((tip, i) => (
          <div key={tip.title} className="grid gap-x-6 gap-y-2 py-6 sm:grid-cols-[auto_1fr]">
            <span className="font-mono text-sm tabular-nums text-primary">
              {String(i + 1).padStart(2, '0')}
            </span>
            <div>
              <h3 className="text-base font-medium text-foreground">
                {tip.title}
              </h3>
              <p className="mt-2 text-pretty text-[15px] font-light leading-relaxed text-foreground">
                {tip.text}
              </p>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
