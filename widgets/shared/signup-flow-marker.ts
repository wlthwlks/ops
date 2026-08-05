/**
 * Signup-flow marker for /apply ↔ Stripe return.
 * localStorage only — survives Stripe redirect. Never stores tokens or PII answers.
 *
 * Key: wlth_signup_flow_v1
 * Value: { memberId, startedAt, v }
 */

export const SIGNUP_FLOW_STORAGE_KEY = "wlth_signup_flow_v1";
export const SIGNUP_FLOW_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
export const SIGNUP_FLOW_VERSION = 1 as const;

export type SignupFlowMarker = {
  v: typeof SIGNUP_FLOW_VERSION;
  memberId: string;
  startedAt: number;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function getStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function normalizeMemberId(memberId: string | null | undefined): string {
  return (memberId || "").trim();
}

/** Parse marker; returns null if missing, corrupt, or expired. */
export function readSignupFlowMarker(now = Date.now()): SignupFlowMarker | null {
  const store = getStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(SIGNUP_FLOW_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as unknown;
    if (!isRecord(data)) {
      clearSignupFlowMarker();
      return null;
    }
    const memberId = normalizeMemberId(
      typeof data.memberId === "string" ? data.memberId : ""
    );
    const startedAt =
      typeof data.startedAt === "number" ? data.startedAt : Number(data.startedAt);
    if (!memberId || !Number.isFinite(startedAt) || startedAt <= 0) {
      clearSignupFlowMarker();
      return null;
    }
    if (now - startedAt > SIGNUP_FLOW_TTL_MS) {
      clearSignupFlowMarker();
      return null;
    }
    return {
      v: SIGNUP_FLOW_VERSION,
      memberId,
      startedAt,
    };
  } catch {
    clearSignupFlowMarker();
    return null;
  }
}

/**
 * Bind / refresh marker to a Memberstack member id (after account create or login mid-signup).
 * Extends the window by resetting startedAt so long Stripe sessions stay valid within TTL.
 */
export function setSignupFlowMarker(memberId: string, now = Date.now()): SignupFlowMarker | null {
  const id = normalizeMemberId(memberId);
  if (!id) return null;
  const marker: SignupFlowMarker = {
    v: SIGNUP_FLOW_VERSION,
    memberId: id,
    startedAt: now,
  };
  const store = getStorage();
  if (!store) return marker;
  try {
    store.setItem(SIGNUP_FLOW_STORAGE_KEY, JSON.stringify(marker));
  } catch {
    /* quota / private mode */
  }
  return marker;
}

/** Clear only after payment verified + final matching saved (signup complete). */
export function clearSignupFlowMarker(): void {
  const store = getStorage();
  if (!store) return;
  try {
    store.removeItem(SIGNUP_FLOW_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * True when the logged-in member may remain on /apply (active, non-expired marker for this id).
 * Logged-out callers should not redirect — pass memberId null/empty → false for "is matching member"
 * but gate logic treats logged-out separately.
 */
export function hasActiveSignupFlowForMember(
  memberId: string | null | undefined,
  now = Date.now()
): boolean {
  const id = normalizeMemberId(memberId);
  if (!id) return false;
  const marker = readSignupFlowMarker(now);
  if (!marker) return false;
  return marker.memberId === id;
}

/**
 * /apply page gate decision.
 * - logged out → stay
 * - logged in + matching marker → stay
 * - logged in + no/expired/other marker → redirect to update-details
 */
export function shouldStayOnApplyPage(input: {
  memberId: string | null | undefined;
  isLoggedIn: boolean;
  now?: number;
}): boolean {
  if (!input.isLoggedIn) return true;
  return hasActiveSignupFlowForMember(input.memberId, input.now ?? Date.now());
}

export function getUpdateDetailsPath(): string {
  return "/update-details";
}

/**
 * Run redirect if logged-in member is not in an active signup flow.
 * Uses location.replace so Back does not bounce them to /apply again.
 */
export function redirectExistingMemberOffApply(input: {
  memberId: string | null | undefined;
  isLoggedIn: boolean;
  updateDetailsPath?: string;
  now?: number;
  /** Injected for tests */
  replace?: (url: string) => void;
}): boolean {
  if (shouldStayOnApplyPage(input)) return false;
  const path = input.updateDetailsPath || getUpdateDetailsPath();
  const replace =
    input.replace ||
    ((url: string) => {
      window.location.replace(url);
    });
  replace(path);
  return true;
}

/** Browser helper: resolve Memberstack member id from DOM when available. */
export async function resolveMemberstackMemberId(): Promise<string | null> {
  try {
    const w = window as unknown as {
      $memberstackDom?: {
        getCurrentMember?: () => Promise<unknown>;
        getMemberCookie?: () => unknown;
      };
    };
    const dom = w.$memberstackDom;
    if (!dom) return null;

    if (typeof dom.getCurrentMember === "function") {
      const res = await dom.getCurrentMember();
      if (isRecord(res)) {
        const data = isRecord(res.data) ? res.data : res;
        const member = isRecord(data.member) ? data.member : data;
        if (typeof member.id === "string" && member.id.trim()) return member.id.trim();
      }
    }

    // Fallback: JWT sub from cookie token (non-sensitive id claim only)
    if (typeof dom.getMemberCookie === "function") {
      const raw = dom.getMemberCookie();
      const value = raw instanceof Promise ? await raw : raw;
      let token = "";
      if (typeof value === "string") token = value.trim();
      else if (isRecord(value) && typeof value.accessToken === "string") {
        token = value.accessToken.trim();
      }
      if (token.split(".").length === 3) {
        const part = token.split(".")[1];
        const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const payload = JSON.parse(atob(padded)) as Record<string, unknown>;
        if (typeof payload.sub === "string" && payload.sub.trim()) return payload.sub.trim();
        if (typeof payload.id === "string" && payload.id.trim()) return payload.id.trim();
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Full /apply gate for Webflow: wait for Memberstack, then stay or redirect.
 * Safe to call multiple times.
 */
export async function runApplyPageMemberGate(opts?: {
  updateDetailsPath?: string;
  replace?: (url: string) => void;
  resolveMemberId?: () => Promise<string | null>;
}): Promise<"stay" | "redirect" | "logged_out"> {
  const resolve = opts?.resolveMemberId || resolveMemberstackMemberId;
  const memberId = await resolve();
  if (!memberId) return "logged_out";

  const redirected = redirectExistingMemberOffApply({
    memberId,
    isLoggedIn: true,
    updateDetailsPath: opts?.updateDetailsPath,
    replace: opts?.replace,
  });
  return redirected ? "redirect" : "stay";
}
