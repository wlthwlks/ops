import { describe, it, expect } from "vitest";
import {
  MEMBER_LIST_FIELDS,
  SLACK_CHANNEL_LIST_FIELDS,
  CITY_LIST_FIELDS,
  toAirtableSchemaError,
  MEMBERS_TABLE,
  SLACK_CHANNELS_TABLE,
} from "@/lib/ops/airtable-fields";

describe("airtable field maps", () => {
  it("Members list fields do not include Slack-channel-only fields", () => {
    expect(MEMBER_LIST_FIELDS).toContain("Name");
    expect(MEMBER_LIST_FIELDS).toContain("Date joined");
    expect(MEMBER_LIST_FIELDS).toContain("City");
    expect(MEMBER_LIST_FIELDS).toContain("City relation");
    expect(MEMBER_LIST_FIELDS).not.toContain("Channel status/donut");
    expect(MEMBER_LIST_FIELDS).not.toContain("Slack Channel ID");
    expect(MEMBER_LIST_FIELDS).not.toContain("group size");
    expect(MEMBER_LIST_FIELDS).not.toContain("Cities");
  });

  it("Slack channels fields use exact export names", () => {
    expect(SLACK_CHANNEL_LIST_FIELDS).toEqual(
      expect.arrayContaining([
        "Name",
        "Cities",
        "group size",
        "Channel status/donut",
        "Slack Channel ID",
      ])
    );
    // Must not request Members-only or phantom "City" on channels
    expect(SLACK_CHANNEL_LIST_FIELDS).not.toContain("email");
    expect(SLACK_CHANNEL_LIST_FIELDS).not.toContain("City");
    expect(SLACK_CHANNEL_LIST_FIELDS).not.toContain("Date joined");
  });

  it("Cities list does not request Name (schema drift source)", () => {
    expect(CITY_LIST_FIELDS).toContain("City");
    expect(CITY_LIST_FIELDS).toContain("Country");
    expect(CITY_LIST_FIELDS).toContain("Slack channels");
    expect(CITY_LIST_FIELDS).not.toContain("Name");
  });

  it("parses unknown field errors with table context", () => {
    const err = new Error(
      `Airtable API error: 422 — {"error":{"type":"UNKNOWN_FIELD_NAME","message":"Unknown field name: \\"Name\\""}}`
    );
    const schema = toAirtableSchemaError(SLACK_CHANNELS_TABLE, err);
    expect(schema).not.toBeNull();
    expect(schema?.code).toBe("AIRTABLE_SCHEMA_MISMATCH");
    expect(schema?.table).toBe(SLACK_CHANNELS_TABLE);
    expect(schema?.field).toBe("Name");
    expect(schema?.message).toContain(SLACK_CHANNELS_TABLE);
  });

  it("returns null for non-schema errors", () => {
    expect(toAirtableSchemaError(MEMBERS_TABLE, new Error("timeout"))).toBeNull();
  });
});
