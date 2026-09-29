import { createRoot } from "react-dom/client";
import { GettingStartedApp } from "./GettingStartedApp";
import "./getting-started.css";

function mount() {
  const el = document.getElementById("wlth-getting-started-root");
  if (!el) return;
  const apiBase = (el.dataset.apiBase || window.location.origin).replace(/\/$/, "");
  const allowAnonymous =
    (el.dataset.allowAnonymous || "").trim().toLowerCase() === "true";
  createRoot(el).render(
    <GettingStartedApp apiBase={apiBase} allowAnonymous={allowAnonymous} />
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
