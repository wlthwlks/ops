const tips = [
  {
    title: "Keep your profile current.",
    text: "Your business changes. Your goals change. Updating your profile helps us make more relevant introductions.",
  },
  {
    title: "Reply to your introductions.",
    text: "A simple hello can turn into a client, collaborator, mentor, referral partner or close friend.",
  },
  {
    title: "Show up when you can.",
    text: "Join your city walks and virtual sessions. Relationships become more valuable the more often you see the same people.",
  },
  {
    title: "Be useful.",
    text: "Tell other founders what you know, who you can introduce and where you can help. Strong networks work in both directions.",
  },
  {
    title: "Follow the connection.",
    text: "Not every valuable conversation needs an immediate business outcome. Some of the best relationships start with simply meeting someone who understands what you’re building.",
  },
];

export function MembershipTips() {
  return (
    <section className="gs-section gs-section--md">
      <div className="gs-section-head">
        <p className="gs-kicker">Make it count</p>
        <h2 className="gs-title">How to get the most from WLTH WLKS</h2>
        <p className="gs-lead">
          The members who get the most value are the ones who participate.
        </p>
      </div>

      <div className="gs-tips">
        {tips.map((tip, i) => (
          <div
            key={tip.title}
            className={
              "gs-card gs-tip" +
              (i === tips.length - 1 && tips.length % 2 !== 0 ? " gs-tip--wide" : "")
            }
          >
            <span className="gs-tip__dot" aria-hidden="true" />
            <div>
              <h3>{tip.title}</h3>
              <p className="gs-body">{tip.text}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
