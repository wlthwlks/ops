import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  expiredPausesFromRecords,
  pauseSnapshotFromRecord,
  resumeMemberIntros,
  setMemberPause,
} from "@/lib/ops/member-pause";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

const deleteMemberSemanticVectors = vi.fn(async () => ({ status: "deleted", deleted: 4 }));
const syncMemberSemanticProfile = vi.fn(async () => ({ status: "embedded", vectorsUpserted: 1, vectorsDeleted: 0 }));

vi.mock("@/lib/introduction/member-profile-sync", () => ({
  deleteMemberSemanticVectors: (id: string) => deleteMemberSemanticVectors(id),
  syncMemberSemanticProfile: (record: unknown) => syncMemberSemanticProfile(record),
}));

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
          [MEMBER_FIELDS.recurringPauseUntil]: "2099-09-01",
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

describe("setMemberPause / resumeMemberIntros — Pinecone hooks", () => {
  const updateRecords = vi.fn(async () => undefined);
  const getRecord = vi.fn();

  function makeAirtable() {
    return {
      updateRecords,
      getRecord,
    } as unknown as import("@/lib/integrations/airtable").AirtableClient;
  }

  const INPUT = {
    airtableRecordId: "rec_pause1",
    clerkUserId: "ops_user",
    mode: "live",
    pauseUntil: "2026-09-01",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getRecord.mockResolvedValue(
      record({ [MEMBER_FIELDS.email]: "ada@x.com", [MEMBER_FIELDS.name]: "Ada" }, "rec_pause1")
    );
  });

  it("pausing deletes the member's semantic vectors immediately", async () => {
    await setMemberPause(INPUT, makeAirtable());
    expect(updateRecords).toHaveBeenCalledWith(
      "MEMBERS",
      expect.arrayContaining([
        expect.objectContaining({
          id: "rec_pause1",
          fields: expect.objectContaining({ [MEMBER_FIELDS.recurringIntroStatus]: "Paused" }),
        }),
      ])
    );
    expect(deleteMemberSemanticVectors).toHaveBeenCalledWith("rec_pause1");
  });

  it("resuming re-embeds the member's semantic vectors immediately", async () => {
    await resumeMemberIntros(INPUT, makeAirtable());
    expect(updateRecords).toHaveBeenCalledWith(
      "MEMBERS",
      expect.arrayContaining([
        expect.objectContaining({
          id: "rec_pause1",
          fields: expect.objectContaining({ [MEMBER_FIELDS.recurringIntroStatus]: "Active" }),
        }),
      ])
    );
    expect(syncMemberSemanticProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "rec_pause1" })
    );
  });

  it("sends null (not empty string) to clear the pause-until date column", async () => {
    await setMemberPause({ ...INPUT, pauseUntil: null }, makeAirtable());
    expect(updateRecords).toHaveBeenCalledWith(
      "MEMBERS",
      expect.arrayContaining([
        expect.objectContaining({
          id: "rec_pause1",
          fields: expect.objectContaining({ [MEMBER_FIELDS.recurringPauseUntil]: null }),
        }),
      ])
    );
    await resumeMemberIntros(INPUT, makeAirtable());
    expect(updateRecords).toHaveBeenCalledWith(
      "MEMBERS",
      expect.arrayContaining([
        expect.objectContaining({
          id: "rec_pause1",
          fields: expect.objectContaining({ [MEMBER_FIELDS.recurringPauseUntil]: null }),
        }),
      ])
    );
  });
});
