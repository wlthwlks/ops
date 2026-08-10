const discover = ["City", "Industry", "Business type", "Profession"];

function ArrowUpRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M7 17L17 7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7 7h10v10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3-3" strokeLinecap="round" />
    </svg>
  );
}

export function MemberDirectory(props: { directoryUrl?: string }) {
  const href = (props.directoryUrl || "").trim() || "#";

  return (
    <section className="gs-section gs-section--md">
      <div className="gs-directory">
        <div className="gs-directory__grid">
          <div className="gs-directory__copy">
            <p className="gs-kicker">Find the right founder when you need her</p>
            <h2>Member Directory</h2>
            <p className="gs-body">
              The WLTH WLKS Member Directory makes the network searchable.
            </p>
            <p className="gs-body">
              Discover founders by{" "}
              <span className="gs-strong">city, industry, business type and profession</span>,
              learn what other members are building, and find women with the experience,
              skills or services you&apos;re looking for.
            </p>
            <p className="gs-body">
              Your own member profile also gives you a place to showcase your business, what
              you do and how other members can connect with you.
            </p>
            <p className="gs-body">Think of it as the WLTH WLKS network made visible.</p>
            <p className="gs-body gs-strong">
              Looking for a designer? A founder in a new city? Someone who has already
              solved the problem you&apos;re facing? Start here.
            </p>
            <div>
              <a className="gs-btn" href={href}>
                Explore the Member Directory
                <ArrowUpRightIcon />
              </a>
            </div>
          </div>

          <div className="gs-directory__side">
            <div className="gs-search-mock">
              <SearchIcon />
              <span>Search the network</span>
            </div>
            <p className="gs-kicker gs-kicker--muted">Discover by</p>
            <div className="gs-chips">
              {discover.map((item) => (
                <span key={item} className="gs-chip">
                  {item}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
