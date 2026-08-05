import { createRoot } from "react-dom/client";
import { SignupApp } from "./SignupApp";
import "../../shared/wlth.css";
import * as signupFlowMarker from "../../shared/signup-flow-marker";

/** Exposed for Webflow /apply page scripts — same helper the widget uses. */
export type WlthSignupFlowApi = {
  storageKey: string;
  ttlMs: number;
  setSignupFlowMarker: typeof signupFlowMarker.setSignupFlowMarker;
  clearSignupFlowMarker: typeof signupFlowMarker.clearSignupFlowMarker;
  readSignupFlowMarker: typeof signupFlowMarker.readSignupFlowMarker;
  hasActiveSignupFlowForMember: typeof signupFlowMarker.hasActiveSignupFlowForMember;
  shouldStayOnApplyPage: typeof signupFlowMarker.shouldStayOnApplyPage;
  redirectExistingMemberOffApply: typeof signupFlowMarker.redirectExistingMemberOffApply;
  runApplyPageMemberGate: typeof signupFlowMarker.runApplyPageMemberGate;
  resolveMemberstackMemberId: typeof signupFlowMarker.resolveMemberstackMemberId;
};

declare global {
  interface Window {
    WlthSignupFlow?: WlthSignupFlowApi;
  }
}

window.WlthSignupFlow = {
  storageKey: signupFlowMarker.SIGNUP_FLOW_STORAGE_KEY,
  ttlMs: signupFlowMarker.SIGNUP_FLOW_TTL_MS,
  setSignupFlowMarker: signupFlowMarker.setSignupFlowMarker,
  clearSignupFlowMarker: signupFlowMarker.clearSignupFlowMarker,
  readSignupFlowMarker: signupFlowMarker.readSignupFlowMarker,
  hasActiveSignupFlowForMember: signupFlowMarker.hasActiveSignupFlowForMember,
  shouldStayOnApplyPage: signupFlowMarker.shouldStayOnApplyPage,
  redirectExistingMemberOffApply: signupFlowMarker.redirectExistingMemberOffApply,
  runApplyPageMemberGate: signupFlowMarker.runApplyPageMemberGate,
  resolveMemberstackMemberId: signupFlowMarker.resolveMemberstackMemberId,
};

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
