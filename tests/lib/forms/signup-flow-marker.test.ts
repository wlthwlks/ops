import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SIGNUP_FLOW_STORAGE_KEY,
  SIGNUP_FLOW_TTL_MS,
  setSignupFlowMarker,
  readSignupFlowMarker,
  clearSignupFlowMarker,
  hasActiveSignupFlowForMember,
  shouldStayOnApplyPage,
  redirectExistingMemberOffApply,
  runApplyPageMemberGate,
} from "../../../widgets/shared/signup-flow-marker";

const store = new Map<string, string>();

function installLocalStorage() {
  store.clear();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
}

describe("signup flow marker (/apply gate)", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  afterEach(() => {
    store.clear();
  });

  it("new signup binds marker to member id", () => {
    const m = setSignupFlowMarker("mem_new_1");
    expect(m?.memberId).toBe("mem_new_1");
    expect(readSignupFlowMarker()?.memberId).toBe("mem_new_1");
    expect(hasActiveSignupFlowForMember("mem_new_1")).toBe(true);
    expect(shouldStayOnApplyPage({ isLoggedIn: true, memberId: "mem_new_1" })).toBe(
      true
    );
  });

  it("logged-out visitor always stays on /apply", () => {
    expect(shouldStayOnApplyPage({ isLoggedIn: false, memberId: null })).toBe(true);
    setSignupFlowMarker("mem_x");
    expect(shouldStayOnApplyPage({ isLoggedIn: false, memberId: "" })).toBe(true);
  });

  it("Stripe return: marker survives and keeps same member on /apply", () => {
    setSignupFlowMarker("mem_stripe");
    // Simulate page reload after Stripe — storage intact
    expect(readSignupFlowMarker()?.memberId).toBe("mem_stripe");
    expect(
      shouldStayOnApplyPage({ isLoggedIn: true, memberId: "mem_stripe" })
    ).toBe(true);
    const replace = vi.fn();
    const redirected = redirectExistingMemberOffApply({
      isLoggedIn: true,
      memberId: "mem_stripe",
      replace,
    });
    expect(redirected).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });

  it("existing member without marker redirects to /update-details", () => {
    const replace = vi.fn();
    const redirected = redirectExistingMemberOffApply({
      isLoggedIn: true,
      memberId: "mem_existing",
      replace,
    });
    expect(redirected).toBe(true);
    expect(replace).toHaveBeenCalledWith("/update-details");
  });

  it("expired marker is cleared and forces redirect", () => {
    const started = Date.now() - SIGNUP_FLOW_TTL_MS - 1000;
    store.set(
      SIGNUP_FLOW_STORAGE_KEY,
      JSON.stringify({ v: 1, memberId: "mem_old", startedAt: started })
    );
    expect(readSignupFlowMarker()).toBeNull();
    expect(store.has(SIGNUP_FLOW_STORAGE_KEY)).toBe(false);
    expect(
      shouldStayOnApplyPage({ isLoggedIn: true, memberId: "mem_old" })
    ).toBe(false);
  });

  it("different member cannot use another member's marker", () => {
    setSignupFlowMarker("mem_a");
    expect(hasActiveSignupFlowForMember("mem_b")).toBe(false);
    expect(shouldStayOnApplyPage({ isLoggedIn: true, memberId: "mem_b" })).toBe(
      false
    );
    const replace = vi.fn();
    redirectExistingMemberOffApply({
      isLoggedIn: true,
      memberId: "mem_b",
      replace,
    });
    expect(replace).toHaveBeenCalledWith("/update-details");
  });

  it("successful signup completion clears marker", () => {
    setSignupFlowMarker("mem_done");
    expect(hasActiveSignupFlowForMember("mem_done")).toBe(true);
    clearSignupFlowMarker();
    expect(readSignupFlowMarker()).toBeNull();
    expect(hasActiveSignupFlowForMember("mem_done")).toBe(false);
    // After complete, same member is treated as existing → redirect off apply
    expect(
      shouldStayOnApplyPage({ isLoggedIn: true, memberId: "mem_done" })
    ).toBe(false);
  });

  it("does not store tokens or secrets", () => {
    setSignupFlowMarker("mem_safe");
    const raw = store.get(SIGNUP_FLOW_STORAGE_KEY) || "";
    expect(raw).not.toMatch(/password|token|Bearer|eyJ/i);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["memberId", "startedAt", "v"]);
  });

  it("runApplyPageMemberGate: logged out stays", async () => {
    const result = await runApplyPageMemberGate({
      resolveMemberId: async () => null,
      replace: vi.fn(),
    });
    expect(result).toBe("logged_out");
  });

  it("runApplyPageMemberGate: new signup marker stays", async () => {
    setSignupFlowMarker("mem_gate");
    const replace = vi.fn();
    const result = await runApplyPageMemberGate({
      resolveMemberId: async () => "mem_gate",
      replace,
    });
    expect(result).toBe("stay");
    expect(replace).not.toHaveBeenCalled();
  });

  it("runApplyPageMemberGate: existing redirects with replace", async () => {
    const replace = vi.fn();
    const result = await runApplyPageMemberGate({
      resolveMemberId: async () => "mem_other",
      replace,
    });
    expect(result).toBe("redirect");
    expect(replace).toHaveBeenCalledWith("/update-details");
  });
});
