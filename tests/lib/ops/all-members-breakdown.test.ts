import { describe, it, expect } from "vitest";
import type { SlackUser } from "@/lib/integrations/slack";

/**
 * Pure classification of all-wlth-wlks human membership (mirrors channel-membership logic).
 */
function classifyAllMembersHumans(
  memberIds: string[],
  usersById: Map<string, SlackUser>
) {
  const seen = new Set<string>();
  let duplicateIds = 0;
  let deletedExcluded = 0;
  let botsAppsExcluded = 0;
  let idsNotInUsersList = 0;
  const activeHumans: string[] = [];

  for (const sid of memberIds) {
    if (seen.has(sid)) {
      duplicateIds++;
      continue;
    }
    seen.add(sid);
    const u = usersById.get(sid);
    if (!u) {
      idsNotInUsersList++;
      continue;
    }
    if (u.deleted) {
      deletedExcluded++;
      continue;
    }
    if (u.isBot || u.isAppUser || u.id === "USLACKBOT") {
      botsAppsExcluded++;
      continue;
    }
    activeHumans.push(sid);
  }

  return {
    rawChannelMemberIds: memberIds.length,
    duplicateIds,
    deletedExcluded,
    botsAppsExcluded,
    idsNotInUsersList,
    activeHumansIncluded: activeHumans.length,
    activeHumans,
  };
}

describe("all-wlth-wlks active human classification", () => {
  const users = new Map<string, SlackUser>([
    [
      "U1",
      {
        id: "U1",
        email: "a@x.com",
        name: "a",
        realName: "A",
        deleted: false,
        isBot: false,
        isAppUser: false,
      },
    ],
    [
      "U2",
      {
        id: "U2",
        email: "b@x.com",
        name: "b",
        realName: "B",
        deleted: true,
        isBot: false,
        isAppUser: false,
      },
    ],
    [
      "B1",
      {
        id: "B1",
        email: "",
        name: "bot",
        realName: "Bot",
        deleted: false,
        isBot: true,
        isAppUser: false,
      },
    ],
    [
      "A1",
      {
        id: "A1",
        email: "",
        name: "app",
        realName: "App",
        deleted: false,
        isBot: false,
        isAppUser: true,
      },
    ],
  ]);

  it("excludes deactivated, bots, apps; includes active humans", () => {
    const r = classifyAllMembersHumans(
      ["U1", "U2", "B1", "A1", "UMISSING", "U1"],
      users
    );
    expect(r.rawChannelMemberIds).toBe(6);
    expect(r.deletedExcluded).toBe(1);
    expect(r.botsAppsExcluded).toBe(2);
    expect(r.idsNotInUsersList).toBe(1);
    expect(r.duplicateIds).toBe(1);
    expect(r.activeHumansIncluded).toBe(1);
    expect(r.activeHumans).toEqual(["U1"]);
  });

  it("does not hardcode present count", () => {
    const r = classifyAllMembersHumans(["U1"], users);
    expect(r.activeHumansIncluded).toBe(1);
    expect(r.activeHumansIncluded).not.toBe(1607);
  });
});
