import { describe, it, expect } from "vitest";
import { selectFreshMatches } from "@/lib/matchmake/select-fresh-matches";

type Cand = { id: string; metadata: { email: string } };

const cand = (id: string, email: string): Cand => ({ id, metadata: { email } });

const opts = (over: Partial<Parameters<typeof selectFreshMatches>[1]> = {}) => ({
  memberId: "self",
  recentlyMatched: new Set<string>(),
  usedInBatch: new Set<string>(),
  target: 5,
  ...over,
});

describe("selectFreshMatches", () => {
  it("takes the top `target` candidates when all are fresh", () => {
    const candidates = [
      cand("1", "a@x.com"),
      cand("2", "b@x.com"),
      cand("3", "c@x.com"),
      cand("4", "d@x.com"),
      cand("5", "e@x.com"),
      cand("6", "f@x.com"),
    ];
    const r = selectFreshMatches(candidates, opts());
    expect(r.matches.map((m) => m.id)).toEqual(["1", "2", "3", "4", "5"]);
    expect(r.recentlyMatchedExcluded).toBe(0);
  });

  it("skips the member themselves by id", () => {
    const candidates = [cand("self", "me@x.com"), cand("2", "b@x.com")];
    const r = selectFreshMatches(candidates, opts({ target: 5 }));
    expect(r.matches.map((m) => m.id)).toEqual(["2"]);
  });

  it("excludes recently-matched emails and substitutes the next-best fresh ones", () => {
    const candidates = [
      cand("1", "locked@x.com"),
      cand("2", "fresh1@x.com"),
      cand("3", "locked2@x.com"),
      cand("4", "fresh2@x.com"),
    ];
    const r = selectFreshMatches(
      candidates,
      opts({
        target: 2,
        recentlyMatched: new Set(["locked@x.com", "locked2@x.com"]),
      })
    );
    expect(r.matches.map((m) => m.id)).toEqual(["2", "4"]);
    // Two locked candidates were ranked ahead of the 2nd fresh one → counted.
    expect(r.recentlyMatchedExcluded).toBe(2);
  });

  it("excludes members already used in this batch (no double count as a repeat)", () => {
    const candidates = [
      cand("1", "used@x.com"),
      cand("2", "fresh@x.com"),
    ];
    const r = selectFreshMatches(
      candidates,
      opts({ target: 5, usedInBatch: new Set(["used@x.com"]) })
    );
    expect(r.matches.map((m) => m.id)).toEqual(["2"]);
    // usedInBatch exclusions are not 30-day-lock repeats.
    expect(r.recentlyMatchedExcluded).toBe(0);
  });

  it("matches case-insensitively on email", () => {
    const candidates = [cand("1", "Locked@X.com"), cand("2", "Fresh@X.com")];
    const r = selectFreshMatches(
      candidates,
      opts({ target: 1, recentlyMatched: new Set(["locked@x.com"]) })
    );
    expect(r.matches.map((m) => m.id)).toEqual(["2"]);
    expect(r.recentlyMatchedExcluded).toBe(1);
  });

  it("returns fewer than target when the pool runs dry (under-fill)", () => {
    const candidates = [
      cand("1", "locked@x.com"),
      cand("2", "fresh@x.com"),
    ];
    const r = selectFreshMatches(
      candidates,
      opts({ target: 5, recentlyMatched: new Set(["locked@x.com"]) })
    );
    expect(r.matches.map((m) => m.id)).toEqual(["2"]);
    expect(r.matches.length).toBeLessThan(5);
  });

  it("skips candidates with no email", () => {
    const candidates = [
      { id: "1", metadata: { email: "" } },
      { id: "2", metadata: { email: "ok@x.com" } },
    ];
    const r = selectFreshMatches(candidates, opts({ target: 5 }));
    expect(r.matches.map((m) => m.id)).toEqual(["2"]);
  });

  it("stops counting repeats once the target is filled", () => {
    // First two are fresh → target met immediately; a later locked candidate
    // should NOT inflate the displaced count.
    const candidates = [
      cand("1", "fresh1@x.com"),
      cand("2", "fresh2@x.com"),
      cand("3", "locked@x.com"),
    ];
    const r = selectFreshMatches(
      candidates,
      opts({ target: 2, recentlyMatched: new Set(["locked@x.com"]) })
    );
    expect(r.matches.map((m) => m.id)).toEqual(["1", "2"]);
    expect(r.recentlyMatchedExcluded).toBe(0);
  });
});
