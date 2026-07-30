import { createRoot } from "react-dom/client";
import { SignupApp } from "./SignupApp";
import "../../shared/wlth.css";

function mount() {
  const el = document.getElementById("wlth-signup-root");
  if (!el) return;
  const apiBase = el.dataset.apiBase || window.location.origin;
  createRoot(el).render(<SignupApp apiBase={apiBase.replace(/\/$/, "")} />);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
