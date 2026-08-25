import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { postMessageMock } = vi.hoisted(() => ({
  postMessageMock: vi.fn(),
}));

vi.mock("@/lib/integrations/slack", () => ({
  createSlackClient: () => ({
    postMessage: (channel: string, text: string) => postMessageMock(channel, text),
  }),
}));

import {
  buildNewPaidMemberMessage,
  notifySignupPaidMemberOnSlack,
} from "@/lib/forms/billing/slack-paid-notify";
import type { AirtableRecord } from "@/lib/integrations/airtable";
import { setLocationCatalogForTests } from "@/lib/forms/reference-data";

function record(fields: Record<string, unknown>): AirtableRecord {
  return { id: "rec123", fields };
}

function enableEnv(): void {
  process.env.BILLING_ALERTS_TO_SLACK_ENABLED = "true";
  process.env.SLACK_WW_BOT_TOKEN = "xoxb-test-token";
  process.env.SLACK_WW_NEW_MEMBERS_CHANNEL = "ww-new-members";
}

function disableEnv(): void {
  delete process.env.BILLING_ALERTS_TO_SLACK_ENABLED;
  delete process.env.SLACK_WW_BOT_TOKEN;
  delete process.env.SLACK_WW_NEW_MEMBERS_CHANNEL;
}

beforeEach(() => {
  postMessageMock.mockReset();
  enableEnv();
});

afterEach(() => {
  disableEnv();
  setLocationCatalogForTests(null);
  postMessageMock.mockReset();
});

describe("buildNewPaidMemberMessage", () => {
  it("renders the full message with city and country", () => {
    expect(
      buildNewPaidMemberMessage({
        fullName: "Jane Doe",
        email: "jane@example.com",
        city: "London",
        country: "United Kingdom",
      })
    ).toBe(
      [
        "New 2.0 WW Member [Paid]",
        "An airtable record was automatically created for Jane Doe (jane@example.com) :blush:",
        ":earth_americas: London (United Kingdom).",
      ].join("\n")
    );
  });

  it("renders city only when country is missing", () => {
    expect(
      buildNewPaidMemberMessage({
        fullName: "Jane Doe",
        email: "jane@example.com",
        city: "Manchester",
        country: "",
      })
    ).toBe(
      [
        "New 2.0 WW Member [Paid]",
        "An airtable record was automatically created for Jane Doe (jane@example.com) :blush:",
        ":earth_americas: Manchester.",
      ].join("\n")
    );
  });

  it("omits the location line when both city and country are missing", () => {
    const msg = buildNewPaidMemberMessage({
      fullName: "Jane Doe",
      email: "jane@example.com",
      city: "",
      country: "",
    });
    expect(msg).toBe(
      [
        "New 2.0 WW Member [Paid]",
        "An airtable record was automatically created for Jane Doe (jane@example.com) :blush:",
      ].join("\n")
    );
  });

  it("falls back to placeholders for missing name/email", () => {
    expect(
      buildNewPaidMemberMessage({ fullName: "", email: "", city: "", country: "" })
    ).toContain("created for — (—) :blush:");
  });
});

describe("notifySignupPaidMemberOnSlack", () => {
  it("no-ops when the feature flag is disabled", async () => {
    process.env.BILLING_ALERTS_TO_SLACK_ENABLED = "false";
    const res = await notifySignupPaidMemberOnSlack(
      record({ "First Name": "Jane", "Last Name": "Doe", email: "jane@example.com" })
    );
    expect(res).toEqual({ sent: false, reason: "flag_disabled" });
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it("no-ops when bot config is missing", async () => {
    delete process.env.SLACK_WW_BOT_TOKEN;
    const res = await notifySignupPaidMemberOnSlack(
      record({ "First Name": "Jane", "Last Name": "Doe", email: "jane@example.com" })
    );
    expect(res).toEqual({ sent: false, reason: "config_missing" });
    expect(postMessageMock).not.toHaveBeenCalled();
  });

  it("posts the expected message with name/email/city text", async () => {
    const res = await notifySignupPaidMemberOnSlack(
      record({
        "First Name": "Jane",
        "Last Name": "Doe",
        email: "jane@example.com",
        City: "Manchester",
      })
    );
    expect(res).toEqual({ sent: true });
    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(postMessageMock).toHaveBeenCalledWith(
      "ww-new-members",
      [
        "New 2.0 WW Member [Paid]",
        "An airtable record was automatically created for Jane Doe (jane@example.com) :blush:",
        ":earth_americas: Manchester.",
      ].join("\n")
    );
  });

  it("resolves city and country from the location catalogue", async () => {
    setLocationCatalogForTests({
      countries: [{ code: "recCountry1", label: "United Kingdom" }],
      cities: [
        {
          code: "recCity1",
          label: "London",
          countryCode: "recCountry1",
          countryLabel: "United Kingdom",
          timezone: "Europe/London",
          legacyCityLabel: "London",
          airtableRecordId: "recCity1",
          hasSlackChannel: false,
          cityTier: "",
          formEnabled: true,
        },
      ],
      source: "airtable",
      fetchedAt: new Date().toISOString(),
    });

    const res = await notifySignupPaidMemberOnSlack(
      record({
        "First Name": "Jane",
        "Last Name": "Doe",
        email: "jane@example.com",
        "City relation": ["recCity1"],
      })
    );
    expect(res).toEqual({ sent: true });
    expect(postMessageMock.mock.calls[0][1]).toBe(
      [
        "New 2.0 WW Member [Paid]",
        "An airtable record was automatically created for Jane Doe (jane@example.com) :blush:",
        ":earth_americas: London (United Kingdom).",
      ].join("\n")
    );
  });

  it("swallows Slack failures and never throws", async () => {
    postMessageMock.mockRejectedValueOnce(new Error("channel_not_found"));
    const res = await notifySignupPaidMemberOnSlack(
      record({ "First Name": "Jane", "Last Name": "Doe", email: "jane@example.com" })
    );
    expect(res).toEqual({ sent: false, reason: "error" });
  });
});
