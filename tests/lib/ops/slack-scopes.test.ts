import { describe, it, expect } from "vitest";
import { classifySlackScopes } from "@/lib/ops/slack-removal";

describe("classifySlackScopes", () => {
  it("no write scopes → cannot kick or invite", () => {
    const caps = classifySlackScopes([
      "users:read",
      "users:read.email",
      "channels:read",
      "groups:read",
    ]);
    expect(caps.canKickFromChannels).toBe(false);
    expect(caps.canInviteToChannels).toBe(false);
    expect(caps.canReadChannels).toBe(true);
  });

  it("channels:manage alone enables kick and invite", () => {
    const caps = classifySlackScopes(["channels:manage"]);
    expect(caps.canKickFromChannels).toBe(true);
    expect(caps.canInviteToChannels).toBe(true);
  });

  it("groups:write enables private-channel invite and kick", () => {
    const caps = classifySlackScopes(["groups:write"]);
    expect(caps.canKickFromChannels).toBe(true);
    expect(caps.canInviteToChannels).toBe(true);
  });

  it("channels:write enables kick but not invite", () => {
    const caps = classifySlackScopes(["channels:write"]);
    expect(caps.canKickFromChannels).toBe(true);
    expect(caps.canInviteToChannels).toBe(false);
  });

  it("empty scopes → nothing possible", () => {
    const caps = classifySlackScopes([]);
    expect(caps.canKickFromChannels).toBe(false);
    expect(caps.canInviteToChannels).toBe(false);
    expect(caps.canReadChannels).toBe(false);
  });

  it("full community set → everything possible", () => {
    const caps = classifySlackScopes([
      "users:read",
      "users:read.email",
      "channels:read",
      "groups:read",
      "groups:write",
      "channels:manage",
    ]);
    expect(caps).toEqual({
      canKickFromChannels: true,
      canInviteToChannels: true,
      canReadChannels: true,
    });
  });
});
