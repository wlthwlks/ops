import { describe, it, expect } from "vitest";
import {
  MEMBER_FIELDS,
  MEMBER_LIST_FIELDS,
  SLACK_CHANNEL_LIST_FIELDS,
  CITY_LIST_FIELDS,
  CITY_FIELDS,
  SLACK_CHANNEL_FIELDS,
  toAirtableSchemaError,
  sanitizeMembersWriteFields,
  MEMBERS_TABLE,
  SLACK_CHANNELS_TABLE,
} from "@/lib/ops/airtable-fields";
import {
  assertMembersWritePayload,
  assertNoForbiddenMembersWrites,
  MEMBERS_WRITABLE_FIELDS,
  isMembersWritableField,
} from "@/lib/airtable/schema";

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

  it("MEMBER_FIELDS uses exact canonical Airtable names", () => {
    expect(MEMBER_FIELDS.email).toBe("email");
    expect(MEMBER_FIELDS.phone).toBe("phone number");
    expect(MEMBER_FIELDS.industry).toBe("Industry");
    expect(MEMBER_FIELDS.revenue).toBe("Revenue");
    expect(MEMBER_FIELDS.ninetyDayGoal).toBe("Current 90-day goal");
    expect(MEMBER_FIELDS.firstAttributionAt).toBe("First attribution captured at");
    expect(MEMBER_FIELDS.serviceAccessUntil).toBe("Service access until");
    expect(MEMBER_FIELDS.recurringIntroStatus).toBe("Recurring intro status");
    expect(MEMBER_FIELDS.utmSource).toBe("UTM Source");
    expect(MEMBER_FIELDS.availabilityV2).toBe("Availability v2");
    expect(MEMBER_FIELDS.helpWantedContext).toBe("Help wanted context");
    expect(MEMBER_FIELDS.expertiseContext).toBe("Expertise context");
    expect(MEMBER_FIELDS.helpWanted).toBe("Help wanted");
    expect(MEMBER_FIELDS.expertise).toBe("Expertise");
    expect(MEMBER_FIELDS.phonePrefix).toBe("Phone prefix");
    expect(MEMBER_FIELDS.phone).toBe("phone number");
    expect(MEMBER_FIELDS.postCode).toBe("post code");
    // Must not expose nonexistent columns
    expect(MEMBER_FIELDS).not.toHaveProperty("lastFormSource");
    expect(MEMBER_FIELDS).not.toHaveProperty("countryCode");
    expect(MEMBER_FIELDS).not.toHaveProperty("cityCode");
    expect(MEMBER_FIELDS).not.toHaveProperty("expertiseOffered");
    expect(MEMBER_FIELDS.businessName).toBe("Business name");
    expect(MEMBER_FIELDS.businessWebsite).toBe("Business website");
    expect(MEMBER_FIELDS.socialMedia).toBe("social media");
  });

  it("Slack channels fields use exact export names", () => {
    expect(SLACK_CHANNEL_FIELDS.groupSize).toBe("group size");
    expect(SLACK_CHANNEL_FIELDS.status).toBe("Channel status/donut");
    expect(SLACK_CHANNEL_FIELDS.slackChannelId).toBe("Slack Channel ID");
    expect(SLACK_CHANNEL_LIST_FIELDS).toEqual(
      expect.arrayContaining([
        "Name",
        "Cities",
        "group size",
        "Channel status/donut",
        "Slack Channel ID",
      ])
    );
    expect(SLACK_CHANNEL_LIST_FIELDS).not.toContain("email");
    expect(SLACK_CHANNEL_LIST_FIELDS).not.toContain("City");
    expect(SLACK_CHANNEL_LIST_FIELDS).not.toContain("Date joined");
  });

  it("Cities list uses City Code / Slack channels / intros / Form enabled", () => {
    expect(CITY_FIELDS.cityCode).toBe("City Code");
    expect(CITY_FIELDS.slackChannels).toBe("Slack channels");
    expect(CITY_FIELDS.intros).toBe("intros");
    expect(CITY_FIELDS.formEnabled).toBe("Form enabled");
    expect(CITY_LIST_FIELDS).toContain("City");
    expect(CITY_LIST_FIELDS).toContain("Country");
    expect(CITY_LIST_FIELDS).toContain("Slack channels");
    expect(CITY_LIST_FIELDS).toContain("City Code");
    expect(CITY_LIST_FIELDS).not.toContain("Name");
  });

  it("sanitizeMembersWriteFields drops Name and Last form source", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const out = sanitizeMembersWriteFields({
        Name: "X",
        "Last form source": "y",
        email: "a@b.com",
        "First Name": "A",
      });
      expect(out.Name).toBeUndefined();
      expect(out["Last form source"]).toBeUndefined();
      expect(out.email).toBe("a@b.com");
      expect(out["First Name"]).toBe("A");
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("assertMembersWritePayload keeps only writable canonical keys", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const out = assertMembersWritePayload({
        email: "a@b.com",
        "Current 90-day goal": "ship",
        "Last form source": "nope",
        Name: "nope",
        "City code": "LON",
      });
      expect(out).toEqual({
        email: "a@b.com",
        "Current 90-day goal": "ship",
      });
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("assertNoForbiddenMembersWrites throws on Name and Last form source", () => {
    expect(() => assertNoForbiddenMembersWrites({ Name: "x" })).toThrow(/Forbidden/);
    expect(() => assertNoForbiddenMembersWrites({ "Last form source": "x" })).toThrow(
      /Forbidden/
    );
    expect(() => assertNoForbiddenMembersWrites({ email: "a@b.com" })).not.toThrow();
  });

  it("writable set includes canonical form fields and excludes Name", () => {
    expect(isMembersWritableField("email")).toBe(true);
    expect(isMembersWritableField("UTM Source")).toBe(true);
    expect(isMembersWritableField("First attribution captured at")).toBe(true);
    expect(isMembersWritableField("Name")).toBe(false);
    expect(isMembersWritableField("Last form source")).toBe(false);
    expect(MEMBERS_WRITABLE_FIELDS).not.toContain("Name");
    expect(MEMBERS_WRITABLE_FIELDS).not.toContain("Last form source");
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
