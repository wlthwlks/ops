/**
 * First-touch attribution capture for signup (localStorage + session fallback).
 * Only allowlisted params are stored.
 */

const STORAGE_KEY = "wlth_attribution_v1";
const MAX_LEN = 500;

const ALLOWED_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "gclid",
  "fbclid",
  "wbraid",
  "gbraid",
] as const;

export type AttributionPayload = {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  gclid?: string;
  fbclid?: string;
  wbraid?: string;
  gbraid?: string;
  initialLandingPage?: string;
  initialReferrer?: string;
  firstAttributionAt?: string;
};

function clamp(v: string): string {
  const t = v.trim();
  if (!t) return "";
  return t.length > MAX_LEN ? t.slice(0, MAX_LEN) : t;
}

function readStore(): AttributionPayload | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AttributionPayload;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeStore(data: AttributionPayload): void {
  const json = JSON.stringify(data);
  try {
    localStorage.setItem(STORAGE_KEY, json);
  } catch {
    /* private mode */
  }
  try {
    sessionStorage.setItem(STORAGE_KEY, json);
  } catch {
    /* ignore */
  }
}

/** Capture first-touch attribution; never overwrites existing first-touch values. */
export function captureAttribution(): AttributionPayload {
  if (typeof window === "undefined") return {};
  const existing = readStore();
  if (existing?.firstAttributionAt) {
    return existing;
  }

  const p = new URLSearchParams(window.location.search);
  const attr: AttributionPayload = {
    initialLandingPage: clamp(window.location.href.split("#")[0]),
    initialReferrer: clamp(document.referrer || ""),
    firstAttributionAt: new Date().toISOString(),
  };
  for (const k of ALLOWED_KEYS) {
    const v = p.get(k);
    if (v) attr[k] = clamp(v);
  }
  writeStore(attr);
  return attr;
}

export function getStoredAttribution(): AttributionPayload {
  return readStore() || {};
}
