import { Check, X } from 'lucide-react'

const please = [
  'Show up to a walk if you commit',
  'Communicate clearly',
  'Be respectful of others\u2019 time',
  'Support fellow founders',
  'Engage in good faith',
]

const pleaseNot = [
  'Aggressively pitch or sell',
  'Ghost introduction groups',
  'No-show without communication',
  'Spam members',
]

export function CommunityGuidelines() {
  return (
    <section className="mx-auto w-full min-w-0 max-w-5xl px-5 sm:px-8">
      <div className="mb-10 flex flex-col gap-2 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-brand text-primary">
          Community Guidelines
        </p>
        <h2 className="text-2xl font-bold uppercase tracking-tight text-foreground sm:text-3xl">
          A community that works for everyone
        </h2>
        <p className="mx-auto mt-2 max-w-2xl text-pretty text-[15px] font-light leading-relaxed text-foreground">
          The best communities work when everyone participates generously. When
          you joined, you agreed to our terms of service, participation
          guidelines and community standards. Here&apos;s a consolidated
          reminder.
        </p>
      </div>

      <div className="grid gap-x-12 gap-y-10 border-y border-border/70 py-10 md:grid-cols-2 md:divide-x md:divide-border/70">
        {/* Please */}
        <div className="md:pr-12">
          <h3 className="text-xs font-semibold uppercase tracking-brand text-foreground">
            Please
          </h3>
          <ul className="mt-6 flex flex-col gap-4">
            {please.map((item) => (
              <li key={item} className="flex items-start gap-3">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <span className="text-[15px] font-light leading-relaxed text-foreground">
                  {item}
                </span>
              </li>
            ))}
          </ul>
        </div>

        {/* Please Do Not */}
        <div className="md:pl-12">
          <h3 className="text-xs font-semibold uppercase tracking-brand text-muted-foreground">
            Please do not
          </h3>
          <ul className="mt-6 flex flex-col gap-4">
            {pleaseNot.map((item) => (
              <li key={item} className="flex items-start gap-3">
                <X className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/70" aria-hidden="true" />
                <span className="text-[15px] font-light leading-relaxed text-foreground">
                  {item}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-10 text-center">
        <p className="text-base font-normal uppercase tracking-brand text-foreground">
          WLTH WLKS is relationship-first.
        </p>
        <p className="mx-auto mt-3 max-w-2xl text-pretty text-[15px] font-light leading-relaxed text-foreground">
          The stronger the community becomes, the more valuable it becomes for
          everyone. A rising tide lifts all boats, for sure.
        </p>
      </div>
    </section>
  )
}
