import { createRoot } from "react-dom/client";
import { UpdateDetailsApp } from "./UpdateDetailsApp";
import "../../shared/wlth.css";

function mount() {
  const el = document.getElementById("wlth-update-details-root");
  if (!el) return;
  const apiBase = el.dataset.apiBase || window.location.origin;
  createRoot(el).render(<UpdateDetailsApp apiBase={apiBase.replace(/\/$/, "")} />);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount);
} else {
  mount();
}
