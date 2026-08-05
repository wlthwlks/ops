/**
 * Once-per-login-session profile refresh gate.
 * Stores only a non-sensitive completion marker in sessionStorage.
 * Never stores raw access tokens.
 */

const STORAGE_PREFIX = "wlth_profile_refresh_done:";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function looksLikeJwt(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

/** Base64url decode JWT payload without verifying (browser fingerprint only). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    if (!looksLikeJwt(token)) return null;
    const part = token.split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    const data = JSON.parse(json) as unknown;
    return isRecord(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Derive a stable, non-sensitive login-session id from Memberstack claims.
 * Prefer jti; else member id + iat. Never returns the raw token.
 */
export function deriveLoginSessionId(input: {
  memberId?: string | null;
  accessToken?: string | null;
  sessionId?: string | null;
}): string | null {
  const explicit = (input.sessionId || "").trim();
  if (explicit) return `ms:${explicit}`;

  const token = (input.accessToken || "").trim();
  const payload = token ? decodeJwtPayload(token) : null;
  const jti = payload && typeof payload.jti === "string" ? payload.jti.trim() : "";
  if (jti) return `jti:${jti}`;

  const mid =
    (input.memberId || "").trim() ||
    (payload && typeof payload.sub === "string" ? payload.sub.trim() : "") ||
    (payload && typeof payload.id === "string" ? payload.id.trim() : "");
  const iat = payload && typeof payload.iat === "number" ? String(payload.iat) : "";
  if (mid && iat) return `m:${mid}:iat:${iat}`;
  if (mid) return `m:${mid}`;
  return null;
}

function storageKey(memberId: string, sessionId: string): string {
  return `${STORAGE_PREFIX}${memberId}:${sessionId}`;
}

export function isProfileRefreshComplete(input: {
  memberId: string;
  sessionId: string;
}): boolean {
  try {
    if (!input.memberId || !input.sessionId) return false;
    return sessionStorage.getItem(storageKey(input.memberId, input.sessionId)) === "1";
  } catch {
    return false;
  }
}

export function markProfileRefreshComplete(input: {
  memberId: string;
  sessionId: string;
}): void {
  try {
    if (!input.memberId || !input.sessionId) return;
    sessionStorage.setItem(storageKey(input.memberId, input.sessionId), "1");
  } catch {
    /* ignore */
  }
}

/**
 * After successful signup completion, skip refresh for this login session.
 */
export function markSignupSessionRefreshComplete(input: {
  memberId?: string | null;
  accessToken?: string | null;
}): void {
  const sessionId = deriveLoginSessionId(input);
  const mid =
    (input.memberId || "").trim() ||
    (() => {
      const p = input.accessToken ? decodeJwtPayload(input.accessToken) : null;
      if (p && typeof p.sub === "string") return p.sub.trim();
      if (p && typeof p.id === "string") return p.id.trim();
      return "";
    })();
  if (mid && sessionId) markProfileRefreshComplete({ memberId: mid, sessionId });
}
