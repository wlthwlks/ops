import { createRoot } from "react-dom/client";
import { MemberDirectoryApp } from "./MemberDirectoryApp";
import "./member-directory.css";

function mount() {
  const el = document.getElementById("wlth-member-directory-root");
  if (!el) return;
  const apiBase = (el.dataset.apiBase || window.location.origin).replace(/\/$/, "");
  const allowAnonymous =
    (el.dataset.allowAnonymous || "").trim().toLowerCase() === "true";
  const gettingStartedUrl =
    (el.dataset.gettingStartedUrl || "/getting-started").trim() || "/getting-started";
  const updateDetailsUrl =
    (el.dataset.updateDetailsUrl || "/update-details").trim() || "/update-details";
  createRoot(el).render(
    <MemberDirectoryApp
      apiBase={apiBase}
      allowAnonymous={allowAnonymous}
      gettingStartedUrl={gettingStartedUrl}
      updateDetailsUrl={updateDetailsUrl}
    />
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
