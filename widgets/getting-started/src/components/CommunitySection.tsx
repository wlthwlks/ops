const COMMUNITY_IMG =
  "https://cdn.prod.website-files.com/67d62dc17cb7c0a57f321eeb/695f45d361c133de35ceac10_IMG_3818.JPG";

export function CommunitySection() {
  return (
    <section className="gs-section gs-section--lg">
      <div className="gs-community">
        <div className="gs-community__grid">
          <div className="gs-community__img">
            <img
              src={COMMUNITY_IMG}
              alt="WLTH WLKS founders connecting on a walk"
            />
            <div className="gs-community__img-shade" />
          </div>

          <div className="gs-community__copy">
            <p className="gs-kicker">Stay connected between introductions</p>
            <h2>The WLTH WLKS Community</h2>
            <div className="gs-body">
              <p>Your membership also connects you to the wider WLTH WLKS community.</p>
              <p>
                Use the community to continue conversations between walks, connect with
                founders in other cities, share what you&apos;re working on, ask questions,
                celebrate wins and discover opportunities across the network.
              </p>
              <p>
                You don&apos;t need to constantly monitor another platform to get value from
                your membership; your introductions and activities will keep coming.
              </p>
              <p className="gs-emphasis">
                But when you want to go deeper, the community is there.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
