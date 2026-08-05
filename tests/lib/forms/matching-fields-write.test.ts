import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

async function loadMembersSync() {
  const { setLocationCatalogForTests } = await import("@/lib/forms/reference-data");
  setLocationCatalogForTests({
    source: "airtable",
    fetchedAt: new Date().toISOString(),
    countries: [],
    cities: [],
  });
  return import("@/lib/forms/airtable/members-sync");
}

describe("help/expertise linked field writes", () => {
  let updateRecords: ReturnType<typeof vi.fn>;
  let listRecords: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env.NEW_UPDATE_DETAILS_WIDGET_ENABLED = "true";
    process.env.MAKE_SHADOW_MODE = "false";
    process.env.AIRTABLE_GET_DATA_TOKEN = "pat_test";
    process.env.AIRTABLE_BASE_ID = "appTEST";

    updateRecords = vi.fn(async (_t: string, rows: Array<{ id: string; fields: Record<string, unknown> }>) =>
      rows.map((r) => ({ id: r.id, fields: r.fields }))
    );
    listRecords = vi.fn(async () => [
      {
        id: "rec_existing",
        fields: {
          [MEMBER_FIELDS.memberstackId]: "mem_1",
          [MEMBER_FIELDS.helpWantedContext]: "GROWTH_MARKETING, need intros",
          [MEMBER_FIELDS.expertiseContext]: "I love mentoring",
        },
      },
    ]);

    vi.doMock("@/lib/integrations/airtable", () => ({
      createAirtableClient: () => ({
        listRecords,
        createRecords: vi.fn(),
        updateRecords,
        updateRecordsBatched: vi.fn(),
        getRecord: vi.fn(),
      }),
    }));
  });

  afterEach(() => {
    vi.doUnmock("@/lib/integrations/airtable");
  });

  it("writes Help wanted and Expertise separately from context", async () => {
    const { updateMemberProfile } = await loadMembersSync();
    await updateMemberProfile({
      memberstackId: "mem_1",
      patch: {
        [MEMBER_FIELDS.helpWanted]: ["recHelp1", "recHelp2"],
        [MEMBER_FIELDS.helpWantedContext]: "Looking for warm intros",
        [MEMBER_FIELDS.expertise]: ["recExp1"],
        [MEMBER_FIELDS.expertiseContext]: "Happy to mentor on product",
      },
    });

    const fields = updateRecords.mock.calls[0][1][0].fields as Record<string, unknown>;
    expect(fields[MEMBER_FIELDS.helpWanted]).toEqual(["recHelp1", "recHelp2"]);
    expect(fields[MEMBER_FIELDS.helpWantedContext]).toBe("Looking for warm intros");
    expect(fields[MEMBER_FIELDS.expertise]).toEqual(["recExp1"]);
    expect(fields[MEMBER_FIELDS.expertiseContext]).toBe("Happy to mentor on product");
    // Must not concatenate codes into context
    expect(String(fields[MEMBER_FIELDS.helpWantedContext])).not.toContain("recHelp");
  });

  it("clears linked selections and context with empty values", async () => {
    const { updateMemberProfile } = await loadMembersSync();
    await updateMemberProfile({
      memberstackId: "mem_1",
      patch: {
        [MEMBER_FIELDS.helpWanted]: [],
        [MEMBER_FIELDS.helpWantedContext]: "",
        [MEMBER_FIELDS.expertise]: [],
        [MEMBER_FIELDS.expertiseContext]: "",
      },
    });

    const fields = updateRecords.mock.calls[0][1][0].fields as Record<string, unknown>;
    expect(fields[MEMBER_FIELDS.helpWanted]).toEqual([]);
    expect(fields[MEMBER_FIELDS.helpWantedContext]).toBe("");
    expect(fields[MEMBER_FIELDS.expertise]).toEqual([]);
    expect(fields[MEMBER_FIELDS.expertiseContext]).toBe("");
  });

  it("reads linked ids and legacy context codes without destroying prose", async () => {
    const { recordToProfileDto } = await loadMembersSync();
    const dto = recordToProfileDto({
      id: "rec1",
      fields: {
        [MEMBER_FIELDS.helpWanted]: ["recA"],
        [MEMBER_FIELDS.helpWantedContext]: "Need growth peers",
        [MEMBER_FIELDS.expertise]: [],
        [MEMBER_FIELDS.expertiseContext]: "LEADERSHIP, I coach founders",
      },
    });
    expect(dto.helpWanted).toEqual(["recA"]);
    expect(dto.helpWantedContext).toBe("Need growth peers");
    expect(dto.expertiseOffered).toEqual(["LEADERSHIP"]);
    expect(dto.expertiseContext).toBe("I coach founders");
  });
});
