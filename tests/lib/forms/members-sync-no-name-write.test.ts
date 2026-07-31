import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";

describe("Airtable member writes never include computed Name", () => {
  const prevSignup = process.env.NEW_SIGNUP_WIDGET_ENABLED;
  const prevUpdate = process.env.NEW_UPDATE_DETAILS_WIDGET_ENABLED;
  const prevShadow = process.env.MAKE_SHADOW_MODE;
  const prevToken = process.env.AIRTABLE_GET_DATA_TOKEN;
  const prevBase = process.env.AIRTABLE_BASE_ID;

  let createRecords: ReturnType<typeof vi.fn>;
  let updateRecords: ReturnType<typeof vi.fn>;
  let listRecords: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env.NEW_SIGNUP_WIDGET_ENABLED = "true";
    process.env.NEW_UPDATE_DETAILS_WIDGET_ENABLED = "true";
    process.env.MAKE_SHADOW_MODE = "false";
    process.env.AIRTABLE_GET_DATA_TOKEN = "pat_test";
    process.env.AIRTABLE_BASE_ID = "appTEST";

    createRecords = vi.fn(async (_t: string, rows: Array<{ fields: Record<string, unknown> }>) =>
      rows.map((r, i) => ({ id: `rec_new_${i}`, fields: r.fields }))
    );
    updateRecords = vi.fn(async (_t: string, rows: Array<{ id: string; fields: Record<string, unknown> }>) =>
      rows.map((r) => ({ id: r.id, fields: r.fields }))
    );
    listRecords = vi.fn(async () => []);

    vi.doMock("@/lib/integrations/airtable", () => ({
      createAirtableClient: () => ({
        listRecords,
        createRecords,
        updateRecords,
        updateRecordsBatched: vi.fn(),
        getRecord: vi.fn(),
      }),
    }));
  });

  afterEach(() => {
    vi.doUnmock("@/lib/integrations/airtable");
    if (prevSignup === undefined) delete process.env.NEW_SIGNUP_WIDGET_ENABLED;
    else process.env.NEW_SIGNUP_WIDGET_ENABLED = prevSignup;
    if (prevUpdate === undefined) delete process.env.NEW_UPDATE_DETAILS_WIDGET_ENABLED;
    else process.env.NEW_UPDATE_DETAILS_WIDGET_ENABLED = prevUpdate;
    if (prevShadow === undefined) delete process.env.MAKE_SHADOW_MODE;
    else process.env.MAKE_SHADOW_MODE = prevShadow;
    if (prevToken === undefined) delete process.env.AIRTABLE_GET_DATA_TOKEN;
    else process.env.AIRTABLE_GET_DATA_TOKEN = prevToken;
    if (prevBase === undefined) delete process.env.AIRTABLE_BASE_ID;
    else process.env.AIRTABLE_BASE_ID = prevBase;
  });

  it("stripComputedMemberWriteFields removes Name", async () => {
    const { stripComputedMemberWriteFields } = await import(
      "@/lib/forms/airtable/members-sync"
    );
    const stripped = stripComputedMemberWriteFields({
      [MEMBER_FIELDS.name]: "Should Go",
      Name: "Also Go",
      name: "too",
      [MEMBER_FIELDS.firstName]: "Ada",
      [MEMBER_FIELDS.email]: "a@b.com",
    });
    expect(stripped[MEMBER_FIELDS.name]).toBeUndefined();
    expect(stripped.Name).toBeUndefined();
    expect(stripped.name).toBeUndefined();
    expect(stripped[MEMBER_FIELDS.firstName]).toBe("Ada");
    expect(stripped[MEMBER_FIELDS.email]).toBe("a@b.com");
  });

  it("upsertMinimalSignupMember create payload has First/Last but not Name", async () => {
    const { upsertMinimalSignupMember } = await import(
      "@/lib/forms/airtable/members-sync"
    );
    await upsertMinimalSignupMember({
      memberstackId: "mem_1",
      email: "ada@ex.com",
      firstName: "Ada",
      lastName: "Lovelace",
    });

    expect(createRecords).toHaveBeenCalledTimes(1);
    const fields = createRecords.mock.calls[0][1][0].fields as Record<string, unknown>;
    expect(fields[MEMBER_FIELDS.firstName]).toBe("Ada");
    expect(fields[MEMBER_FIELDS.lastName]).toBe("Lovelace");
    expect(fields[MEMBER_FIELDS.email]).toBe("ada@ex.com");
    expect(fields[MEMBER_FIELDS.memberstackId]).toBe("mem_1");
    expect(fields[MEMBER_FIELDS.name]).toBeUndefined();
    expect(fields.Name).toBeUndefined();
  });

  it("updateMemberProfile does not write Name when first/last change", async () => {
    listRecords.mockResolvedValue([
      {
        id: "rec_existing",
        fields: {
          [MEMBER_FIELDS.memberstackId]: "mem_1",
          [MEMBER_FIELDS.firstName]: "Old",
          [MEMBER_FIELDS.lastName]: "Name",
        },
      },
    ]);

    const { updateMemberProfile } = await import("@/lib/forms/airtable/members-sync");
    await updateMemberProfile({
      memberstackId: "mem_1",
      patch: {
        [MEMBER_FIELDS.firstName]: "New",
        [MEMBER_FIELDS.lastName]: "Person",
      },
    });

    expect(updateRecords).toHaveBeenCalledTimes(1);
    const fields = updateRecords.mock.calls[0][1][0].fields as Record<string, unknown>;
    expect(fields[MEMBER_FIELDS.firstName]).toBe("New");
    expect(fields[MEMBER_FIELDS.lastName]).toBe("Person");
    expect(fields[MEMBER_FIELDS.name]).toBeUndefined();
    expect(fields.Name).toBeUndefined();
  });

  it("recordToProfileDto still reads Name for display", async () => {
    const { recordToProfileDto } = await import("@/lib/forms/airtable/members-sync");
    const dto = recordToProfileDto({
      id: "rec1",
      fields: {
        [MEMBER_FIELDS.name]: "Computed Full",
        [MEMBER_FIELDS.firstName]: "First",
        [MEMBER_FIELDS.lastName]: "Last",
        [MEMBER_FIELDS.email]: "a@b.com",
      },
    });
    expect(dto.name).toBe("Computed Full");
    expect(dto.firstName).toBe("First");
  });
});
