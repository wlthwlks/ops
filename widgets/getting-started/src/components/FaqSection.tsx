import type { ReactNode } from 'react'
import { Plus } from 'lucide-react'

const conversationStarters = [
  'What are you currently building?',
  'What\u2019s your biggest challenge right now?',
  'What\u2019s something exciting happening in your business?',
  'What are you struggling with operationally?',
  'What does growth currently look like for you?',
  'What are you optimizing for this year?',
  'What support would help you most right now?',
  'What\u2019s something you\u2019ve learned recently?',
  'What\u2019s your biggest founder lesson so far?',
  'What are you personally working on outside business?',
]

const refundCriteria = [
  'Completed their onboarding profile fully',
  'Responded to introductions within 4 days',
  'Attempted to schedule at least 1 walk',
  'Attended at least 1 walk or demonstrated good-faith effort',
  'Remained an active Slack participant',
  'Requested support before requesting a refund',
]

type Faq = {
  q: string
  a: ReactNode
}

const faqs: Faq[] = [
  {
    q: 'Do you have any conversation starters for the walks?',
    a: (
      <>
        <p>Not sure what to talk about? Try these conversation starters:</p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2">
          {conversationStarters.map((s) => (
            <li key={s} className="flex items-start gap-2.5">
              <span
                className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                aria-hidden="true"
              />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      </>
    ),
  },
  {
    q: 'I didn\u2019t receive my introduction',
    a: (
      <>
        <p>Your introduction arrives on the 1st of each month.</p>
        <p>
          If you join after the 1st (for example, on the 3rd), your first
          introduction will be sent on the 1st of the following month.
        </p>
        <p>
          In the meantime, you can still make the most of your membership: join
          our virtual sessions, come to CITY WLKS in your city, and connect with
          founders inside Slack.
        </p>
      </>
    ),
  },
  {
    q: 'How can I see my city channel on Slack?',
    a: (
      <p>
        You&apos;ll be manually added to your city channel upon joining Slack. If
        you don&apos;t see your city channel, DM Sarah with the name of your city
        channel and she&apos;ll add you in.
      </p>
    ),
  },
  {
    q: 'Nobody replied in my intro group',
    a: (
      <p>
        This occasionally happens, and is against our community standards.
        Sometimes things come up for people and they forget to pause, but we do
        check in on how often this happens and enforce our community standards
        when it does. And as for your intro? Don&apos;t worry. Introductions
        happen every 2 weeks, so you&apos;ll receive another group soon.
      </p>
    ),
  },
  {
    q: 'Only a few people replied in my intro group. Should we still go on a walk?',
    a: (
      <p>
        We have strict community standards and are working hard to enforce them.
        When you are paired with other founders, we expect everyone to engage,
        even if it&apos;s to say, hey I can&apos;t make it this time. If a few of
        you are still up for a walk, go with those engaging. We&apos;re monitoring
        things on our end too, but feel free to let us know as well at{' '}
        <a href="mailto:info@wlthwlks.com" className="text-primary underline-offset-2 hover:underline">
          info@wlthwlks.com
        </a>
        .
      </p>
    ),
  },
  {
    q: 'My introduction and I didn\u2019t hit it off',
    a: (
      <>
        <p>
          WLTH WLKS facilitates introductions, not guaranteed perfect matches.
          Not every introduction will become a deep friendship or business
          relationship, and that&apos;s normal. That&apos;s why we introduce you
          to new groups regularly.
        </p>
        <p>
          The magic of WLTH WLKS comes from consistency, participation, showing up
          and proactively connecting.
        </p>
        <p>
          Keep putting yourself out there. Join the sessions, show up to CITY
          WLKS, stay in the mix, and the right people and conversations will
          come.
        </p>
      </>
    ),
  },
  {
    q: 'Do you have any tips for scheduling?',
    a: (
      <>
        <p>The easiest way to organize a meetup is this:</p>
        <ol className="mt-2 flex flex-col gap-2">
          <li className="flex gap-3">
            <span className="font-semibold text-primary">1.</span>
            <span>
              Create a group message with everyone in your intro thread (or just
              hit reply all if you prefer email).
            </span>
          </li>
          <li className="flex gap-3">
            <span className="font-semibold text-primary">2.</span>
            <span>
              Use the WhatsApp Poll function or TallyCal to easily determine the
              best time for your group.
            </span>
          </li>
        </ol>
        <p>
          Take the initiative and start the conversation by suggesting a date,
          time and a good walking spot.{' '}
          <span className="text-foreground">
            We recommend meeting during your monthly CITY WLKS or the second/third
            Friday at 9:00 am.
          </span>{' '}
          The only requirement is the meetup must be centered around walking.
        </p>
      </>
    ),
  },
  {
    q: 'Do you offer a money back guarantee?',
    a: (
      <>
        <p>
          We stand behind the experience. If you actively participate and
          don&apos;t feel WLTH WLKS delivered on its promise, our team will work
          with you directly to make it right.
        </p>
        <p>To be eligible, members must have:</p>
        <ul className="mt-2 flex flex-col gap-2">
          {refundCriteria.map((c) => (
            <li key={c} className="flex items-start gap-2.5">
              <span
                className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                aria-hidden="true"
              />
              <span>{c}</span>
            </li>
          ))}
        </ul>
        <p>
          Refund requests must be submitted within 14 days of your first
          introduction. Memberships are not refundable due to lack of
          participation, inactivity, schedule availability, relocation, or
          personal preference. Email{' '}
          <a href="mailto:info@wlthwlks.com" className="text-primary underline-offset-2 hover:underline">
            info@wlthwlks.com
          </a>{' '}
          and we can help you from there.
        </p>
      </>
    ),
  },
  {
    q: 'What is WLTH Collective?',
    a: (
      <p>
        WLTH Collective is a private community for ambitious female founders who
        crave more out of life. As WLTH WLKS expanded city by city, something
        powerful started to happen: women were showing up for the walk, but they
        were craving more than just steps and surface-level chats. They wanted
        deeper conversations, bigger collaborations and a space to build their
        business alongside women who just got it. So we built that. To apply,
        email us at{' '}
        <a href="mailto:info@wlthwlks.com" className="text-primary underline-offset-2 hover:underline">
          info@wlthwlks.com
        </a>{' '}
        and to learn more visit{' '}
        <a
          href="https://wlthwlks.com/wlth-collective"
          className="text-primary underline-offset-2 hover:underline"
        >
          wlthwlks.com/wlth-collective
        </a>
        .
      </p>
    ),
  },
]

export function FaqSection() {
  return (
    <section className="mx-auto w-full min-w-0 max-w-3xl px-5 sm:px-8">
      <div className="mb-10 flex flex-col gap-2 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-brand text-primary">
          Good to know
        </p>
        <h2 className="text-2xl font-bold uppercase tracking-tight text-foreground sm:text-3xl">
          FAQs
        </h2>
        <p className="mx-auto mt-2 max-w-xl text-pretty text-[15px] font-light leading-relaxed text-muted-foreground">
          Have an issue? Contact our team at{' '}
          <a href="mailto:info@wlthwlks.com" className="text-primary underline-offset-2 hover:underline">
            info@wlthwlks.com
          </a>
          .
        </p>
      </div>

      <div className="border-t border-border/70">
        {faqs.map((faq) => (
          <details
            key={faq.q}
            className="group border-b border-border/70"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 [&::-webkit-details-marker]:hidden">
              <span className="text-[15px] font-medium text-foreground transition-colors group-hover:text-primary sm:text-base">
                {faq.q}
              </span>
              <span className="flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground transition-transform duration-300 group-open:rotate-45 group-open:text-primary">
                <Plus className="h-4 w-4" aria-hidden="true" />
              </span>
            </summary>
            <div className="space-y-3 pb-6 pr-10 text-[15px] font-light leading-relaxed text-muted-foreground">
              {faq.a}
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}
