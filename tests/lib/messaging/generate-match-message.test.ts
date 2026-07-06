import { describe, it, expect } from "vitest";
import { generateMatchMessage } from "@/lib/messaging/generate-match-message";
import type { MessageMember } from "@/lib/messaging/types";

const newMember: MessageMember = {
  name: "Alice Smith",
  email: "alice@x.com",
  industry: "SaaS",
  businessStage: "Early Scale",
  nearbyLocation: "Shoreditch, Old Street",
  availability: "Weekday mornings",
  topics: "pricing",
};

const matchWithData: MessageMember = {
  name: "Bob Jones",
  email: "bob@x.com",
  industry: "SaaS",
  businessStage: "Early Scale",
  nearbyLocation: "Shoreditch, Hackney",
  availability: "Weekends",
  topics: "hiring",
};

const matchNoData: MessageMember = {
  name: "Carol Lee",
  email: "carol@x.com",
  industry: "Retail",
  businessStage: "Pre-Revenue",
  nearbyLocation: "Shoreditch",
};

describe("generateMatchMessage — Slack join link in email", () => {
  const url = "https://join.slack.com/t/wlth-wlks/abc";

  it("includes the Slack join URL when the member is NOT on Slack", () => {
    const { body } = generateMatchMessage({
      newMember, matches: [matchWithData], format: "html",
      slackInviteUrl: url, isOnSlack: false,
    });
    expect(body).toContain(url);
    expect(body).toContain("Join the WLTH WLKS Slack");
  });

  it("still includes the Slack join URL when the member IS on Slack", () => {
    const { body } = generateMatchMessage({
      newMember, matches: [matchWithData], format: "html",
      slackInviteUrl: url, isOnSlack: true,
    });
    expect(body).toContain(url);
    // …alongside the group-DM note.
    expect(body).toContain("added you to a Slack group");
  });

  it("omits the join link cleanly when no URL is configured", () => {
    const { body } = generateMatchMessage({
      newMember, matches: [matchWithData], format: "html", isOnSlack: false,
    });
    expect(body).not.toContain("Join the WLTH WLKS Slack");
  });
});

describe("generateMatchMessage — availability & topics surfacing", () => {
  for (const format of ["slack", "html", "plaintext"] as const) {
    it(`${format}: surfaces each member's availability when present`, () => {
      const { body } = generateMatchMessage({
        newMember,
        matches: [matchWithData, matchNoData],
        format,
      });
      expect(body).toContain("Weekday mornings");
      expect(body).toContain("Weekends");
    });

    it(`${format}: surfaces topics when present`, () => {
      const { body } = generateMatchMessage({
        newMember,
        matches: [matchWithData, matchNoData],
        format,
      });
      expect(body).toContain("pricing");
      expect(body).toContain("hiring");
    });

    it(`${format}: still suggests the shared location meeting spot`, () => {
      const { body } = generateMatchMessage({
        newMember,
        matches: [matchWithData, matchNoData],
        format,
      });
      // All three share "Shoreditch" → it must appear as a meeting spot.
      expect(body).toContain("Shoreditch");
    });

    it(`${format}: does not expose match email addresses in the copy (they're BCC'd)`, () => {
      const { body } = generateMatchMessage({
        newMember,
        matches: [matchWithData, matchNoData],
        format,
      });
      expect(body).not.toContain("bob@x.com");
      expect(body).not.toContain("carol@x.com");
      expect(body).not.toContain("mailto:");
    });

    it(`${format}: omits availability/topics blocks when nobody supplied them`, () => {
      const plain = (m: MessageMember): MessageMember => ({
        name: m.name,
        email: m.email,
        industry: m.industry,
        businessStage: m.businessStage,
        nearbyLocation: m.nearbyLocation,
      });
      const { body } = generateMatchMessage({
        newMember: plain(newMember),
        matches: [plain(matchWithData), plain(matchNoData)],
        format,
      });
      expect(body).not.toMatch(/free to meet/i);
      expect(body).not.toMatch(/want to discuss/i);
    });
  }
});
