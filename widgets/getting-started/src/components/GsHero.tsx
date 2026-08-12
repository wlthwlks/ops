const HERO_IMG =
  "https://framerusercontent.com/images/ZWx0YzGf2TsVqPekBx6y2yTfWnc.jpg?width=1200&height=675";

export function GsHero() {
  return (
    <section className="gs-hero">
      <div className="gs-hero__bg">
        <img src={HERO_IMG} alt="" aria-hidden="true" />
        <div className="gs-hero__shade" />
        <div className="gs-hero__grain" />
      </div>

      <div className="gs-hero__content">
        <span className="gs-pill gs-fade-up">Getting Started</span>
        <h1 className="gs-fade-up" style={{ animationDelay: "0.08s" }}>
          Getting started with WLTH <span className="gs-accent">WLKS</span>
        </h1>
        <p className="gs-hero__tagline gs-fade-up" style={{ animationDelay: "0.16s" }}>
          You&apos;re in. Now make the most of your membership.
        </p>
        <p className="gs-hero__desc gs-fade-up" style={{ animationDelay: "0.22s" }}>
          WLTH WLKS is a global community for ambitious female founders who are done
          building alone. Your membership gives you{" "}
          <strong className="gs-strong">
            curated founder introductions, monthly City WLTH WLKS, virtual networking
            sessions, a global community, and access to women building businesses across
            industries, stages and cities around the world.
          </strong>
        </p>
        <p className="gs-hero__cta-line gs-fade-up" style={{ animationDelay: "0.28s" }}>
          There's always a reason to connect; and getting started is simple.
        </p>
      </div>
    </section>
  );
}
