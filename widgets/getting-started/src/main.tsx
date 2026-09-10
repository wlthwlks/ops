import { createRoot } from "react-dom/client";
import { GettingStartedApp } from "./GettingStartedApp";
import "./getting-started.css";

const EVENTS_URL_PREVIEW = "https://wlthwlks.webflow.io/events";
const EVENTS_URL_PRODUCTION = "https://women.wlthwlks.com/events";

function resolveEventsUrl(): string {
  const el = document.getElementById("wlth-getting-started-root");
  const override = (el?.dataset.eventsUrl || "").trim();
  if (override) return override;
  if (window.location.hostname.endsWith(".webflow.io")) {
    return EVENTS_URL_PREVIEW;
  }
  return EVENTS_URL_PRODUCTION;
}

function mount() {
  const el = document.getElementById("wlth-getting-started-root");
  if (!el) return;
  // const directoryUrl = el.dataset.directoryUrl || ""; // Temporarily hidden
  const allowAnonymous =
    (el.dataset.allowAnonymous || "").trim().toLowerCase() === "true";
  createRoot(el).render(
    <GettingStartedApp
      allowAnonymous={allowAnonymous}
      eventsUrl={resolveEventsUrl()}
    />
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
