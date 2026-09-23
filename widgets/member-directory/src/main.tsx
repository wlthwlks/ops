import { createRoot } from "react-dom/client";
import { MemberDirectoryApp } from "./MemberDirectoryApp";
import "./member-directory.css";

function mount() {
  const el = document.getElementById("wlth-member-directory-root");
  if (!el) return;
  const apiBase = (el.dataset.apiBase || window.location.origin).replace(/\/$/, "");
  const allowAnonymous =
    (el.dataset.allowAnonymous || "").trim().toLowerCase() === "true";
  createRoot(el).render(
    <MemberDirectoryApp apiBase={apiBase} allowAnonymous={allowAnonymous} />
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
