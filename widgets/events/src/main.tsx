import { createRoot } from "react-dom/client";
import { EventsApp } from "./EventsApp";
import "./events.css";

const DEFAULT_EMBED_SRC =
  "https://app.staging.sweatpals.com/static/embed/community/events/script.js?communityUsername=wlth_wlks_demo_925264&defaultView=list&viewsJson=%5B%22list%22%5D&filtersJson=%5B%22fitness-type%22%2C%22Location%22%2C%22type%22%2C%22date-picker%22%2C%22price-range%22%5D&showDescription=false&directToCheckout=false&enableAutoEmbed=true&backgroundColorHex=110c0e&brandColorHex=be2327&fontFamily=SN%20Skandia&cardStyle=modern&displayTimeMode=first&contentVisibilityJson=%7B%22tag%22%3Atrue%2C%22title%22%3Atrue%2C%22subtitle%22%3Atrue%2C%22howItWorks%22%3Atrue%2C%22membershipIntroOffer%22%3Atrue%2C%22membershipPerExperiencePrice%22%3Atrue%2C%22membershipDescription%22%3Atrue%2C%22membershipInclusions%22%3Atrue%2C%22startTime%22%3Atrue%2C%22duration%22%3Atrue%2C%22coverImage%22%3Atrue%2C%22address%22%3Atrue%2C%22price%22%3Atrue%2C%22priceWithMembership%22%3Atrue%2C%22tags%22%3Atrue%2C%22shareButton%22%3Atrue%2C%22rsvps%22%3Atrue%2C%22capacity%22%3Atrue%2C%22host%22%3Atrue%2C%22coHost%22%3Atrue%2C%22instructor%22%3Atrue%7D&bookingBehavior=open-experience-details&buttonText=Book%20now&animationsEnabled=true&glassEffectEnabled=true&heightMode=auto&spacingsMode=tight&maxWidth=1120&cornerRadius=24&showWidgetTitle=true";

function mount() {
  const el = document.getElementById("wlth-events-root");
  if (!el) return;
  const embedSrc = (el.dataset.embedSrc || "").trim() || DEFAULT_EMBED_SRC;
  createRoot(el).render(<EventsApp embedSrc={embedSrc} />);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
