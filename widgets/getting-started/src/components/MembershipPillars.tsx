import type { ReactNode } from 'react'
import { BrandButton } from './BrandButton'

type Pillar = {
  number: string
  kicker: string
  title: string
  body: ReactNode
}

const virtualPrograms = [
  {
    name: 'Monthly Virtual Socials',
    text: 'A relaxed, camera-on call connecting founders across 60+ cities. No pitch required. Just women building big things, in one room, wherever they are in the world.',
  },
  {
    name: 'WLTH TLKS Masterclasses',
    text: 'Our monthly online masterclass, hosted by a subject matter expert from WLTH Collective. In August we had Sierra from Planting Digital Co break down everything social media. Real coaching, from women who\u2019ve actually done it.',
  },
  {
    name: 'Networking Labs',
    text: 'Live sessions where you bring whatever\u2019s on your mind \u2014 networking questions, business problems, things you just need to say out loud to someone who gets it, plus updates on what\u2019s happening across the community. Think founder office hours, not a webinar.',
  },
]

const pillars: Pillar[] = [
  {
    number: '01',
    kicker: 'Meet founders we think you should know',
    title: 'Curated Introductions',
    body: (
      <>
        <p className="text-foreground text-[15px] leading-relaxed">
          On the 1st of every month you&apos;ll get a curated introduction to two
          female founders in your city, matched to your stage, your industry and
          your goals.
        </p>
        <p className="text-foreground text-[15px] leading-relaxed">
          No searching through hundreds of profiles. No awkward networking room.
        </p>
        <p className="text-foreground text-[15px] leading-relaxed">
          Just an introduction to women worth knowing.
        </p>
        <p className="text-foreground text-[15px] leading-relaxed">
          The introduction is ours. The relationship is yours.
        </p>
        <p className="text-foreground text-[15px] leading-relaxed">
          From there, start a conversation, jump on a call, meet for coffee or go
          for a walk together.
        </p>
        <p className="text-sm italic text-foreground">
          WLTH WLKS facilitates introductions, not guaranteed perfect matches.
          Not every introduction will become a deep friendship or business
          relationship, and that&apos;s normal. That&apos;s why we introduce you
          to new groups regularly.
        </p>
        <p className="text-foreground text-[15px] leading-relaxed">
          The magic of WLTH WLKS comes from consistency, participation, showing
          up, and proactively connecting.
        </p>
        <p className="text-foreground text-[15px] leading-relaxed">
          We also host monthly CITY WLKS in our core cities and offer more
          in-depth residencies through our WLTH Collective program. We&apos;ll
          share more details on these in due course.
        </p>
        <p className="text-foreground text-[15px] leading-relaxed">
          To get better introductions, keep your member profile up to date so we
          understand what you&apos;re building, what you need help with and what
          you can offer other founders.
        </p>
      </>
    ),
  },
  {
    number: '02',
    kicker: 'Your network doesn\u2019t stop where you live',
    title: 'Virtual Programming',
    body: (
      <>
        <p className="text-foreground text-[15px] leading-relaxed">
          WLTH WLKS virtual sessions connect founders from different cities,
          industries and business stages through facilitated conversations and
          member networking.
        </p>
        <dl className="mt-2 divide-y divide-border/70 border-y border-border/70">
          {virtualPrograms.map((program) => (
            <div key={program.name} className="py-5">
              <dt className="text-[13px] font-semibold uppercase tracking-brand text-primary">
                {program.name}
              </dt>
              <dd className="mt-2 text-[15px] font-light leading-relaxed text-foreground">
                {program.text}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-foreground text-[15px] leading-relaxed">
          These sessions give you access to the global WLTH WLKS founder network,
          wherever you happen to be.
        </p>
        <div className="pt-2">
          <BrandButton>Add WLTH WLKS Community Calendar</BrandButton>
        </div>
      </>
    ),
  },
  {
    number: '03',
    kicker: 'Meet the founders in your city',
    title: 'CITY WLKS',
    body: (
      <>
        <p className="text-foreground text-[15px] leading-relaxed">
          A monthly walk that brings every member in your city together in one
          place, hosted by a local City Host. Large group format, same rhythm
          each month.
        </p>
        <p className="text-foreground text-[15px] leading-relaxed">
          Real conversations with real women. No pitching, no small talk, no
          bullshit.
        </p>
        <p className="text-foreground text-[15px] leading-relaxed">
          We&apos;re rolling these out city by city, starting where we have the
          density and a WLTH Collective member on the ground to host. Our first
          cities are LA, Lisbon, Cape Town, and San Diego, with more to follow.
        </p>
        <p className="text-foreground text-[15px] leading-relaxed">
          The moment a city hits 50+ members and has a host, we bring CITY WLKS
          there next. And if you want to be the one who brings it to your city,
          I&apos;d love to hear from you.
        </p>
        <div className="pt-2">
          <BrandButton>Upcoming CITY WLKS</BrandButton>
        </div>
      </>
    ),
  },
  {
    number: '04',
    kicker: 'Continue the conversation between walks',
    title: 'The Community',
    body: (
      <>
        <p className="text-foreground text-[15px] leading-relaxed">
          Join our Slack community to connect with the global WLTH WLKS network.
          Chat someone in London while you&apos;re in Vancouver. Talk strategy
          with a founder in New York. Connect with someone building a completely
          different business who sees a problem in a way you hadn&apos;t
          considered.
        </p>
        <p className="text-foreground text-[15px] leading-relaxed">
          Use the community to continue conversations between walks, connect with
          founders in other cities, share what you&apos;re working on, ask
          questions, celebrate wins and discover opportunities across the network.
        </p>
        <p className="text-foreground text-[15px] leading-relaxed">
          You don&apos;t need to constantly monitor another platform to get value
          from your membership; your introductions and activities will keep
          coming.
        </p>
        <div className="pt-2">
          <BrandButton>Join WLTH WLKS Slack Community</BrandButton>
        </div>
      </>
    ),
  },
]

export function MembershipPillars() {
  return (
    <section className="mx-auto w-full min-w-0 max-w-4xl px-5 sm:px-8">
      <div className="mb-14 flex flex-col gap-2 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-brand text-primary">
          What you get
        </p>
        <h2 className="text-2xl font-bold uppercase tracking-tight text-foreground sm:text-3xl">
          Your membership at a glance
        </h2>
      </div>

      <div className="flex flex-col">
        {pillars.map((p, i) => (
          <article
            key={p.number}
            className={`grid gap-x-8 gap-y-4 py-12 sm:grid-cols-[auto_1fr] ${
              i !== 0 ? 'border-t border-border/70' : ''
            }`}
          >
            <div className="flex items-baseline gap-4 sm:flex-col sm:gap-2">
              <span className="font-mono text-sm tabular-nums text-primary">
                {p.number}
              </span>
            </div>
            <div>
              <p className="text-[11px] font-normal uppercase tracking-brand text-muted-foreground">
                {p.kicker}
              </p>
              <h3 className="mt-2 text-xl font-bold uppercase tracking-tight text-foreground sm:text-2xl">
                {p.title}
              </h3>
              <div className="mt-6 space-y-4 text-[15px] font-light leading-relaxed text-foreground">
                {p.body}
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
