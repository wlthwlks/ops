import { describe, it, expect } from "vitest";
import { resolveSlackIdentity } from "@/lib/ops/member-health";
import type { SlackUser } from "@/lib/integrations/slack";

function user(partial: Partial<SlackUser> & { id: string }): SlackUser {
  return {
    id: partial.id,
    email: partial.email || "",
    name: partial.name || "u",
    realName: partial.realName || partial.name || "u",
    deleted: partial.deleted ?? false,
    isBot: partial.isBot ?? false,
    isAppUser: partial.isAppUser ?? false,
  };
}

function maps(users: SlackUser[]) {
  const emailToUser = new Map<string, SlackUser[]>();
  const nameToUser = new Map<string, SlackUser[]>();
  const userById = new Map<string, SlackUser>();
  for (const u of users) {
    userById.set(u.id, u);
    if (u.email) {
      const e = u.email.trim().toLowerCase();
      emailToUser.set(e, [...(emailToUser.get(e) || []), u]);
    }
    const n = (u.realName || u.name).toLowerCase().replace(/[^a-z0-9\s]/g, "").trim();
    if (n) nameToUser.set(n, [...(nameToUser.get(n) || []), u]);
  }
  return { emailToUser, nameToUser, userById };
}

describe("resolveSlackIdentity", () => {
  it("matches existing slack email", () => {
    const u = user({ id: "U1", email: "s@ex.com", realName: "Sam" });
    const r = resolveSlackIdentity({
      primaryEmail: "p@ex.com",
      slackEmail: "s@ex.com",
      name: "Sam",
      ...maps([u]),
    });
    expect(r.state).toBe("matched_slack_email");
  });

  it("matches primary email", () => {
    const u = user({ id: "U1", email: "p@ex.com", realName: "Pat" });
    const r = resolveSlackIdentity({
      primaryEmail: "p@ex.com",
      slackEmail: "",
      name: "Pat",
      ...maps([u]),
    });
    expect(r.state).toBe("matched_primary_email");
  });

  it("detects stale slack email", () => {
    const r = resolveSlackIdentity({
      primaryEmail: "p@ex.com",
      slackEmail: "gone@ex.com",
      name: "Pat",
      ...maps([]),
    });
    expect(r.state).toBe("stale_slack_email");
  });

  it("unique name suggestion", () => {
    const u = user({ id: "U1", email: "x@ex.com", realName: "Unique Name" });
    const r = resolveSlackIdentity({
      primaryEmail: "other@ex.com",
      slackEmail: "",
      name: "Unique Name",
      ...maps([u]),
    });
    expect(r.state).toBe("suggested_name");
    expect(r.confidence).toBe("low");
  });

  it("ambiguous name", () => {
    const users = [
      user({ id: "U1", email: "a@ex.com", realName: "Jane Doe" }),
      user({ id: "U2", email: "b@ex.com", realName: "Jane Doe" }),
    ];
    const r = resolveSlackIdentity({
      primaryEmail: "c@ex.com",
      slackEmail: "",
      name: "Jane Doe",
      ...maps(users),
    });
    expect(r.state).toBe("ambiguous");
  });

  it("ignores bots", () => {
    const bot = user({ id: "B1", email: "p@ex.com", isBot: true, realName: "Bot" });
    const r = resolveSlackIdentity({
      primaryEmail: "p@ex.com",
      slackEmail: "",
      name: "Bot",
      ...maps([bot]),
    });
    expect(r.state).toBe("not_found");
  });

  it("detects deactivated", () => {
    const u = user({ id: "U1", email: "p@ex.com", deleted: true });
    const r = resolveSlackIdentity({
      primaryEmail: "p@ex.com",
      slackEmail: "",
      name: "Pat",
      ...maps([u]),
    });
    expect(r.state).toBe("deactivated");
  });
});
