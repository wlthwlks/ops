import type { ReactNode } from "react";

type Pillar = {
  number: string;
  kicker: string;
  title: string;
  body: ReactNode;
};

const pillars: Pillar[] = [
  {
    number: "01",
    kicker: "Meet founders we think you should know",
    title: "Curated Introductions",
    body: (
      <>
        <p>
          On the <strong className="gs-strong">1st of every month</strong>, we&apos;ll
          introduce you by email to{" "}
          <strong className="gs-strong">two other founders</strong> selected to form a
          curated group of three.
        </p>
        <p>
          We look at things like your{" "}
          <strong className="gs-strong">city, industry, business stage and interests</strong>{" "}
          to create introductions that make sense for where you are right now.
        </p>
        <p>No searching through hundreds of profiles. No awkward networking room.</p>
        <p>Just an introduction to women worth knowing.</p>
        <p className="gs-emphasis">The introduction is ours. The relationship is yours.</p>
        <p>
          From there, start a conversation, jump on a call, meet for coffee or go for a
          walk together.
        </p>
        <p>
          <strong className="gs-strong">To get better introductions:</strong> keep your
          member profile up to date so we understand what you&apos;re building, what you
          need help with and what you can offer other founders.
        </p>
      </>
    ),
  },
  {
    number: "02",
    kicker: "Meet the founders in your city",
    title: "City WLTH WLKS",
    body: (
      <>
        <p>
          Once a month, members come together for a local WLTH WLK hosted by a City Host.
        </p>
        <p className="gs-emphasis">It&apos;s simple: show up, walk and talk.</p>
        <p>No name badges. No formal networking. No sitting through presentations.</p>
        <p>
          It&apos;s a chance to have real conversations with other female founders in your
          city and turn introductions into genuine business relationships; and sometimes
          friendships too.
        </p>
        <p>
          Cities with established WLTH WLKS communities have recurring local walks, while
          growing cities begin by connecting members virtually until their local community
          is ready to launch.
        </p>
      </>
    ),
  },
  {
    number: "03",
    kicker: "Build connections beyond your city",
    title: "Virtual Networking",
    body: (
      <>
        <p>Your network doesn&apos;t stop where you live.</p>
        <p>
          WLTH WLKS virtual sessions connect founders from different cities, industries and
          business stages through facilitated conversations and member networking.
        </p>
        <p>
          Meet someone in London while you&apos;re in Auckland. Talk strategy with a founder
          in New York. Connect with someone building a completely different business who
          sees a problem in a way you hadn&apos;t considered.
        </p>
        <p>
          These sessions give you access to the{" "}
          <strong className="gs-strong">global WLTH WLKS founder network</strong>, wherever
          you happen to be.
        </p>
      </>
    ),
  },
];

export function MembershipPillars() {
  return (
    <section className="gs-section gs-section--md">
      <div className="gs-section-head">
        <p className="gs-kicker">What you get</p>
        <h2 className="gs-title">Your membership at a glance</h2>
      </div>

      <div className="gs-card-stack">
        {pillars.map((p) => (
          <article key={p.number} className="gs-card gs-pillar">
            <div className="gs-pillar__grid">
              <div>
                <span className="gs-pillar__num">{p.number}</span>
              </div>
              <div>
                <p className="gs-kicker gs-kicker--muted">{p.kicker}</p>
                <h3>{p.title}</h3>
                <div className="gs-body gs-pillar__body">{p.body}</div>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
