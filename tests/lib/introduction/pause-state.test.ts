import { describe, it, expect } from "vitest";
import {
  introPauseClearPatch,
  parsePauseUntil,
  resolveIntroPauseState,
} from "@/lib/introduction/pause-state";

const NOW = new Date("2026-08-20T12:00:00Z");

describe("resolveIntroPauseState", () => {
  it("treats blank and Active as active", () => {
    expect(resolveIntroPauseState("", null, NOW)).toMatchObject({
      state: "active",
      isPaused: false,
    });
    expect(resolveIntroPauseState("Active", "", NOW)).toMatchObject({
      state: "active",
      isPaused: false,
    });
  });

  it("treats Excluded as excluded, never paused", () => {
    expect(resolveIntroPauseState("Excluded", "2026-01-01", NOW)).toMatchObject({
      state: "excluded",
      isPaused: false,
    });
  });

  it("pauses until the resume date (date-only resolves to midnight UTC)", () => {
    expect(
      resolveIntroPauseState("Paused", "2026-09-01", NOW).isPaused
    ).toBe(true);
    // Same date as NOW (noon) — the date parsed to midnight, so it has passed.
    expect(
      resolveIntroPauseState("Paused", "2026-08-20", NOW).isPaused
    ).toBe(false);
    expect(
      resolveIntroPauseState("Paused", "2026-08-19", NOW).isPaused
    ).toBe(false);
  });

  it("fails closed when the pause date is missing or unparsable", () => {
    expect(resolveIntroPauseState("Paused", null, NOW)).toMatchObject({
      state: "paused",
      isPaused: true,
      missingDate: true,
    });
    expect(resolveIntroPauseState("Paused", "not-a-date", NOW)).toMatchObject({
      state: "paused",
      isPaused: true,
      missingDate: true,
    });
  });

  it("matches statuses case-insensitively", () => {
    expect(resolveIntroPauseState("paused", "2026-09-01", NOW).state).toBe("paused");
    expect(resolveIntroPauseState("excluded", null, NOW).state).toBe("excluded");
    expect(resolveIntroPauseState("ACTIVE", null, NOW).state).toBe("active");
  });

  it("keeps unknown statuses as unknown (not paused)", () => {
    expect(resolveIntroPauseState("SomethingElse", null, NOW)).toMatchObject({
      state: "unknown",
      isPaused: false,
    });
  });
});

describe("introPauseClearPatch", () => {
  it("clears only a Paused state", () => {
    expect(introPauseClearPatch({ recurringIntroStatus: "Paused" })).toEqual({
      "Recurring intro status": "Active",
      "Recurring pause until": "",
    });
  });

  it("never touches Excluded, Active, or unknown states", () => {
    for (const status of ["Excluded", "Active", "", "SomethingElse", undefined]) {
      expect(introPauseClearPatch({ recurringIntroStatus: status ?? "" })).toEqual({});
    }
  });
});

describe("parsePauseUntil", () => {
  it("parses dates and rejects junk", () => {
    expect(parsePauseUntil("2026-09-01")).toBeInstanceOf(Date);
    expect(parsePauseUntil("")).toBeNull();
    expect(parsePauseUntil(null)).toBeNull();
    expect(parsePauseUntil("nope")).toBeNull();
  });
});
