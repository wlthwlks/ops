/**
 * Production-only Able CDP events for the signup widget.
 * Webflow owns PageView + ue.js init — this module only calls window.uipe("track", …).
 */

const PRODUCTION_HOSTNAME = "women.wlthwlks.com";

declare global {
  interface Window {
    uipe?: (...args: unknown[]) => void;
  }
}

/** In-memory dedupe for the current document lifecycle only. */
const firedKeys = new Set<string>();

function readEnabledFlag(): boolean {
  try {
    return String(import.meta.env.VITE_ABLE_TRACKING_ENABLED || "").trim() === "true";
  } catch {
    return false;
  }
}

function getHostname(): string {
  try {
    if (typeof window === "undefined") return "";
    return String(window.location?.hostname || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

/** Exact production host + explicit build flag. Never uses NODE_ENV/MODE. */
export function isAbleTrackingEnabled(): boolean {
  if (getHostname() !== PRODUCTION_HOSTNAME) return false;
  if (!readEnabledFlag()) return false;
  return true;
}

function normalizeEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

function dedupeKey(eventName: string, memberId: string, email: string): string {
  const id = String(memberId || "").trim();
  if (id) return `${eventName}:${id}`;
  const em = normalizeEmail(email);
  if (em) return `${eventName}:email:${em}`;
  return `${eventName}:unknown`;
}

function trackAble(
  eventName: "Lead" | "Auth",
  payload: Record<string, unknown>,
  identity: { memberId?: string; email?: string }
): void {
  try {
    if (!isAbleTrackingEnabled()) return;
    if (typeof window === "undefined") return;
    const uipe = window.uipe;
    if (typeof uipe !== "function") return;

    const key = dedupeKey(eventName, identity.memberId || "", identity.email || "");
    if (firedKeys.has(key)) return;
    firedKeys.add(key);

    uipe("track", eventName, payload);
  } catch {
    /* never interrupt signup */
  }
}

export function trackAbleLead(input: {
  email: string;
  memberId: string;
  firstName: string;
  lastName: string;
}): void {
  const email = normalizeEmail(input.email);
  const clientId = String(input.memberId || "").trim();
  if (!email && !clientId) return;

  trackAble(
    "Lead",
    {
      keys: {
        email,
        client_id: clientId,
      },
      lead: {
        firstName: String(input.firstName || "").trim(),
        lastName: String(input.lastName || "").trim(),
      },
    },
    { memberId: clientId, email }
  );
}

export function trackAbleAuth(input: { email: string; memberId: string }): void {
  const email = normalizeEmail(input.email);
  const clientId = String(input.memberId || "").trim();
  if (!email && !clientId) return;

  trackAble(
    "Auth",
    {
      keys: {
        email,
        client_id: clientId,
      },
    },
    { memberId: clientId, email }
  );
}

/** Test-only: clear in-memory dedupe set. */
export function __resetAbleTrackingDedupeForTests(): void {
  firedKeys.clear();
}
