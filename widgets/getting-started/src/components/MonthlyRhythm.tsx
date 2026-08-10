const weeks = [
  {
    label: "Week 1",
    title: "Your introductions arrive",
    text: "Meet the two founders selected for your monthly introduction and start the conversation.",
  },
  {
    label: "Week 2",
    title: "Connect virtually",
    text: "Join a virtual networking session and meet founders beyond your usual circle.",
  },
  {
    label: "Week 3",
    title: "Walk with your city",
    text: "Join your City WLTH WLK and spend time with the women building businesses around you.",
  },
  {
    label: "Week 4",
    title: "Keep the momentum going",
    text: "Reconnect through another virtual session and continue building relationships between walks.",
  },
];

export function MonthlyRhythm() {
  return (
    <section className="gs-section gs-section--lg">
      <div className="gs-section-head">
        <p className="gs-kicker">A simple monthly rhythm</p>
        <h2 className="gs-title">There&apos;s something happening throughout the month</h2>
        <p className="gs-lead">
          Your membership is designed around a simple monthly rhythm.
        </p>
      </div>

      <ol className="gs-weeks">
        {weeks.map((w) => (
          <li key={w.label} className="gs-card gs-week">
            <span className="gs-kicker">{w.label}</span>
            <h3>{w.title}</h3>
            <p className="gs-body">{w.text}</p>
          </li>
        ))}
      </ol>

      <p className="gs-rhythm-end">
        Introductions. Conversations. Walks.{" "}
        <span className="gs-accent">Relationships. Repeat.</span>
      </p>
    </section>
  );
}
