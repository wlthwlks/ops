import { describe, it, expect } from "vitest";
import {
  expiredPausesFromRecords,
  pauseSnapshotFromRecord,
} from "@/lib/ops/member-pause";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

const NOW = new Date("2026-08-20T12:00:00Z");

function record(fields: Record<string, unknown>, id = "rec1") {
  return { id, fields };
}

describe("pauseSnapshotFromRecord", () => {
  it("resolves active, paused, expired-paused and excluded states", () => {
    expect(
      pauseSnapshotFromRecord(
        record({
          [MEMBER_FIELDS.recurringIntroStatus]: "Paused",
          [MEMBER_FIELDS.recurringPauseUntil]: "2026-09-01",
        })
      )
    ).toMatchObject({ state: "paused", isPaused: true, missingDate: false });
  });

  it("flags missing pause dates", () => {
    const snap = pauseSnapshotFromRecord(
      record({ [MEMBER_FIELDS.recurringIntroStatus]: "Paused" })
    );
    expect(snap.state).toBe("paused");
    expect(snap.missingDate).toBe(true);
    expect(snap.isPaused).toBe(true);
  });
});

describe("expiredPausesFromRecords", () => {
  it("returns only Paused rows whose date has passed", () => {
    const rows = [
      record({
        [MEMBER_FIELDS.name]: "Ada",
        [MEMBER_FIELDS.email]: "ada@x.com",
        [MEMBER_FIELDS.recurringIntroStatus]: "Paused",
        [MEMBER_FIELDS.recurringPauseUntil]: "2026-08-01",
      }),
      record({
        [MEMBER_FIELDS.name]: "Bob",
        [MEMBER_FIELDS.email]: "bob@x.com",
        [MEMBER_FIELDS.recurringIntroStatus]: "Paused",
        [MEMBER_FIELDS.recurringPauseUntil]: "2026-12-01",
      }),
      record({
        [MEMBER_FIELDS.name]: "Cara",
        [MEMBER_FIELDS.email]: "cara@x.com",
        [MEMBER_FIELDS.recurringIntroStatus]: "Active",
        [MEMBER_FIELDS.recurringPauseUntil]: "2026-01-01",
      }),
    ];
    const expired = expiredPausesFromRecords(rows, NOW);
    expect(expired.map((r) => r.name)).toEqual(["Ada"]);
    expect(expired[0].airtableRecordId).toBe("rec1");
  });

  it("never auto-resumes Paused rows with missing or unparsable dates", () => {
    const rows = [
      record({ [MEMBER_FIELDS.recurringIntroStatus]: "Paused" }),
      record({
        [MEMBER_FIELDS.recurringIntroStatus]: "Paused",
        [MEMBER_FIELDS.recurringPauseUntil]: "garbage",
      }),
    ];
    expect(expiredPausesFromRecords(rows, NOW)).toEqual([]);
  });

  it("matches status case-insensitively", () => {
    const rows = [
      record({
        [MEMBER_FIELDS.recurringIntroStatus]: "paused",
        [MEMBER_FIELDS.recurringPauseUntil]: "2026-08-01",
      }),
    ];
    expect(expiredPausesFromRecords(rows, NOW)).toHaveLength(1);
  });
});
