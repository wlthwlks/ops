import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...import.meta.env };

async function loadAble(hostname: string, flag: string | undefined) {
  vi.resetModules();
  vi.stubGlobal("window", {
    location: { hostname },
    uipe: vi.fn(),
  });
  // Re-stub import.meta.env via vi.stubEnv when available
  vi.stubEnv("VITE_ABLE_TRACKING_ENABLED", flag ?? "");
  return import("../../../widgets/shared/able-tracking");
}

describe("able-tracking", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    void originalEnv;
  });

  it("allows Lead/Auth on production host with flag true", async () => {
    const able = await loadAble("women.wlthwlks.com", "true");
    able.__resetAbleTrackingDedupeForTests();
    expect(able.isAbleTrackingEnabled()).toBe(true);

    able.trackAbleLead({
      email: " Ada@Ex.COM ",
      memberId: "mem_1",
      firstName: "Ada",
      lastName: "Lovelace",
    });
    able.trackAbleAuth({ email: " Ada@Ex.COM ", memberId: "mem_1" });

    const uipe = (window as unknown as { uipe: ReturnType<typeof vi.fn> }).uipe;
    expect(uipe).toHaveBeenCalledTimes(2);
    expect(uipe.mock.calls[0][0]).toBe("track");
    expect(uipe.mock.calls[0][1]).toBe("Lead");
    expect(uipe.mock.calls[0][2]).toEqual({
      keys: { email: "ada@ex.com", client_id: "mem_1" },
      lead: { firstName: "Ada", lastName: "Lovelace" },
    });
    expect(uipe.mock.calls[1][1]).toBe("Auth");
    expect(uipe.mock.calls[1][2]).toEqual({
      keys: { email: "ada@ex.com", client_id: "mem_1" },
    });
  });

  it("blocks localhost", async () => {
    for (const host of ["localhost", "127.0.0.1"]) {
      const able = await loadAble(host, "true");
      able.__resetAbleTrackingDedupeForTests();
      expect(able.isAbleTrackingEnabled()).toBe(false);
      able.trackAbleLead({
        email: "a@b.com",
        memberId: "mem_1",
        firstName: "A",
        lastName: "B",
      });
      expect(
        (window as unknown as { uipe: ReturnType<typeof vi.fn> }).uipe
      ).not.toHaveBeenCalled();
    }
  });

  it("blocks vercel preview and webflow staging", async () => {
    for (const host of ["ops-git-main.vercel.app", "wlth.webflow.io"]) {
      const able = await loadAble(host, "true");
      able.__resetAbleTrackingDedupeForTests();
      expect(able.isAbleTrackingEnabled()).toBe(false);
      able.trackAbleAuth({ email: "a@b.com", memberId: "mem_1" });
      expect(
        (window as unknown as { uipe: ReturnType<typeof vi.fn> }).uipe
      ).not.toHaveBeenCalled();
    }
  });

  it("blocks production host when flag missing/false", async () => {
    for (const flag of [undefined, "", "false", "1"]) {
      const able = await loadAble("women.wlthwlks.com", flag);
      able.__resetAbleTrackingDedupeForTests();
      expect(able.isAbleTrackingEnabled()).toBe(false);
      able.trackAbleLead({
        email: "a@b.com",
        memberId: "mem_1",
        firstName: "A",
        lastName: "B",
      });
      expect(
        (window as unknown as { uipe: ReturnType<typeof vi.fn> }).uipe
      ).not.toHaveBeenCalled();
    }
  });

  it("skips when uipe missing without throwing", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_ABLE_TRACKING_ENABLED", "true");
    vi.stubGlobal("window", {
      location: { hostname: "women.wlthwlks.com" },
    });
    const able = await import("../../../widgets/shared/able-tracking");
    able.__resetAbleTrackingDedupeForTests();
    expect(() =>
      able.trackAbleLead({
        email: "a@b.com",
        memberId: "mem_1",
        firstName: "A",
        lastName: "B",
      })
    ).not.toThrow();
  });

  it("swallows uipe errors", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_ABLE_TRACKING_ENABLED", "true");
    vi.stubGlobal("window", {
      location: { hostname: "women.wlthwlks.com" },
      uipe: vi.fn(() => {
        throw new Error("blocked");
      }),
    });
    const able = await import("../../../widgets/shared/able-tracking");
    able.__resetAbleTrackingDedupeForTests();
    expect(() => {
      able.trackAbleLead({
        email: "a@b.com",
        memberId: "mem_1",
        firstName: "A",
        lastName: "B",
      });
      able.trackAbleAuth({ email: "a@b.com", memberId: "mem_1" });
    }).not.toThrow();
  });

  it("dedupes Lead/Auth per member in the same document", async () => {
    const able = await loadAble("women.wlthwlks.com", "true");
    able.__resetAbleTrackingDedupeForTests();
    const uipe = (window as unknown as { uipe: ReturnType<typeof vi.fn> }).uipe;

    able.trackAbleLead({
      email: "a@b.com",
      memberId: "mem_1",
      firstName: "A",
      lastName: "B",
    });
    able.trackAbleLead({
      email: "a@b.com",
      memberId: "mem_1",
      firstName: "A",
      lastName: "B",
    });
    able.trackAbleAuth({ email: "a@b.com", memberId: "mem_1" });
    able.trackAbleAuth({ email: "a@b.com", memberId: "mem_1" });

    expect(uipe).toHaveBeenCalledTimes(2);
    expect(uipe.mock.calls.map((c) => c[1])).toEqual(["Lead", "Auth"]);
  });
});
