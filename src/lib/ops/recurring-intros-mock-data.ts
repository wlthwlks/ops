/**
 * Shared mock data and read-only utilities for recurring city intros testing.
 * Used by both the CLI script and the dashboard API routes.
 */

import type { AirtableClient, AirtableRecord } from "../integrations/airtable";
import type { SlackClient, SlackUser } from "../integrations/slack";

const CITY_RECORD_ID = "rec_city_london";
const CITY_NAME = "London";
const CHANNEL_RECORD_ID = "rec_ch_london";
const SLACK_CHANNEL_ID = "C_LONDON_123";

export interface MockMembers {
  airtable: AirtableRecord[];
  slack: SlackUser[];
}

export function getMockMembers(): MockMembers {
  const rows = [
    { id: "rec_m_01", name: "Alice Johnson", email: "alice@wlth.test", city: CITY_NAME, payment: "Paid", membership: "Active", status: "", pauseUntil: null },
    { id: "rec_m_02", name: "Bob Smith", email: "bob@wlth.test", city: CITY_NAME, payment: "Paid", membership: "Active", status: "", pauseUntil: null },
    { id: "rec_m_03", name: "Charlie Brown", email: "charlie@wlth.test", city: CITY_NAME, payment: "Paid", membership: "Active", status: "", pauseUntil: null },
    { id: "rec_m_04", name: "Diana Prince", email: "diana@wlth.test", city: CITY_NAME, payment: "Paid", membership: "Active", status: "", pauseUntil: null },
    { id: "rec_m_05", name: "Eve Adams", email: "eve@wlth.test", city: CITY_NAME, payment: "Paid", membership: "Active", status: "", pauseUntil: null },
    { id: "rec_m_06", name: "Frank Castle", email: "frank@wlth.test", city: CITY_NAME, payment: "Paid", membership: "Active", status: "", pauseUntil: null },
    { id: "rec_m_07", name: "Grace Hopper", email: "grace@wlth.test", city: CITY_NAME, payment: "Paid", membership: "Active", status: "", pauseUntil: null },
    { id: "rec_m_08", name: "Hank Pym", email: "hank@wlth.test", city: CITY_NAME, payment: "Paid", membership: "Active", status: "", pauseUntil: null },
    { id: "rec_m_09", name: "Ivy Chen", email: "ivy@wlth.test", city: CITY_NAME, payment: "Unpaid", membership: "Active", status: "", pauseUntil: null },
    { id: "rec_m_10", name: "Jack Ryan", email: "jack@wlth.test", city: CITY_NAME, payment: "Paid", membership: "Active", status: "Excluded", pauseUntil: null },
    { id: "rec_m_11", name: "Karen Page", email: "karen@wlth.test", city: CITY_NAME, payment: "Paid", membership: "Active", status: "", pauseUntil: "2099-12-31" },
    { id: "rec_m_12", name: "Leo Messi", email: "leo@wlth.test", city: CITY_NAME, payment: "Paid", membership: "Active", status: "", pauseUntil: null },
  ];

  const airtable: AirtableRecord[] = rows.map((r) => ({
    id: r.id,
    fields: {
      Name: r.name,
      email: r.email,
      "Slack Email": r.email,
      City: r.city,
      Payment: r.payment,
      Membership: r.membership,
      "Recurring intro status": r.status,
      "Recurring pause until": r.pauseUntil,
    },
  }));

  const slack: SlackUser[] = rows.map((r, i) => ({
    id: `U_FAKE_${String(i + 1).padStart(2, "0")}`,
    email: r.email,
    name: r.name.toLowerCase().replace(/\s+/g, "."),
    realName: r.name,
    deleted: false,
    isBot: false,
    isAppUser: false,
  }));

  return { airtable, slack };
}

const FAKE_MEMBERS = getMockMembers();

function fakeChannelRecord(): AirtableRecord {
  return {
    id: CHANNEL_RECORD_ID,
    fields: {
      Name: "London Walks",
      Cities: CITY_RECORD_ID,
      "group size": 3,
      "Channel status/donut": "Active",
      "Slack Channel ID": SLACK_CHANNEL_ID,
      "Intro type": "Standard",
      "Strict group size": false,
      "Intro frequency weeks": 1,
      "Next introduction date": "2026-06-01",
      "Intro local time": "09:00",
      Timezone: "Europe/London",
      "Intro message template": "Hey {{participants}}! Time for a coffee chat in {{city}}.",
      "Scheduling mode": "",
      "Google Calendar enabled": false,
      "Outlook enabled": false,
      "Auto schedule meeting": false,
      "Meeting duration minutes": 0,
    },
  };
}

function fakeCityRecord(): AirtableRecord {
  return { id: CITY_RECORD_ID, fields: { Name: CITY_NAME } };
}

export function createMockAirtable(matchGroupRecords: AirtableRecord[] = []): AirtableClient {
  const records: Record<string, AirtableRecord[]> = {
    "SLACK CHANNELS": [fakeChannelRecord()],
    "ALL CITIES": [fakeCityRecord()],
    MEMBERS: FAKE_MEMBERS.airtable,
    "MATCH GROUPS": matchGroupRecords,
    "Introduction data": [
      {
        id: "rec_intro_1",
        fields: {
          City: CITY_NAME,
          "Introduction message": "Hey {{participants}}! Time for a coffee chat in {{city}}.",
        },
      },
    ],
  };

  return {
    listRecords: async (table: string) => records[table] || [],
    getRecord: async (_table: string, id: string) => ({ id, fields: {} }),
    createRecords: async (table: string, newRecords: { fields: Record<string, unknown> }[]) => {
      console.log(`[mock-airtable] createRecords → ${table}: ${newRecords.length} record(s)`);
      return newRecords.map((r, i) => ({ id: `created_${i}`, fields: r.fields }));
    },
    createRecordsBatched: async (table: string, newRecords: { fields: Record<string, unknown> }[]) => {
      console.log(`[mock-airtable] createRecordsBatched → ${table}: ${newRecords.length} record(s)`);
      return newRecords.map((r, i) => ({ id: `created_batch_${i}`, fields: r.fields }));
    },
    updateRecords: async (table: string, updates: { id: string; fields: Record<string, unknown> }[]) => {
      console.log(`[mock-airtable] updateRecords → ${table}: ${updates.length} record(s)`);
      return updates;
    },
    updateRecordsBatched: async (table: string, updates: { id: string; fields: Record<string, unknown> }[]) => {
      console.log(`[mock-airtable] updateRecordsBatched → ${table}: ${updates.length} record(s)`);
      return updates;
    },
    updateRecordsBatchedDetailed: async (
      table: string,
      updates: { id: string; fields: Record<string, unknown> }[]
    ) => {
      console.log(`[mock-airtable] updateRecordsBatchedDetailed → ${table}: ${updates.length} record(s)`);
      return {
        results: updates,
        successIds: updates.map((u) => u.id),
        failedBatchIndex: null,
        error: null,
      };
    },
  };
}

export function createMockSlack(): SlackClient {
  return {
    postMessage: async (channelId: string, text: string) => {
      console.log(`[mock-slack] postMessage → ${channelId}: ${text.slice(0, 80)}...`);
      return { ts: `${Date.now()}.000123`, text, channel: channelId };
    },
    getChannelHistory: async () => [],
    sendWebhook: async () => {},
    lookupByEmail: async () => null,
    conversationsOpen: async (userIds: string[]) => {
      console.log(`[mock-slack] conversations.open → users: ${userIds.join(", ")}`);
      return { channelId: `D_MOCK_${Date.now()}` };
    },
    listUsers: async () => FAKE_MEMBERS.slack,
    getConversationMembers: async (_channelId: string) => {
      return FAKE_MEMBERS.slack.filter((u) => !u.deleted && !u.isBot).map((u) => u.id);
    },
    authTest: async () => ({
      url: "https://mock.slack.com",
      team: "Mock Team",
      scopes: ["users:read", "users:read.email", "channels:read", "groups:read"],
    }),
    inviteToChannel: async (channelId: string, userId: string) => {
      console.log(`[mock-slack] conversations.invite → ${channelId}: ${userId}`);
    },
    inviteUsersToWorkspace: async (emails: string[]) =>
      emails.map((email) => ({ email, ok: true })),
    deactivateUser: async (userId: string) => {
      console.log(`[mock-slack] admin.users.setInactive → ${userId}`);
    },
    reactivateUser: async (userId: string) => {
      console.log(`[mock-slack] admin.users.setRegular → ${userId}`);
    },
    getUserInfo: async (userId: string) =>
      FAKE_MEMBERS.slack.find((u) => u.id === userId) || null,
  };
}

// ---------------------------------------------------------------------------
// Safe preview mode: read real Airtable data, block all writes
// ---------------------------------------------------------------------------

/**
 * Wraps a real AirtableClient so that read methods (`listRecords`, `getRecord`)
 * pass through to the real client, but all write methods throw immediately.
 *
 * This is a hardcoded safety layer — no env var or flag can bypass it.
 */
export function createReadOnlyAirtableWrapper(realClient: AirtableClient): AirtableClient {
  const WRITE_BLOCKED = "Write blocked — Safe Preview mode";

  return {
    listRecords: async (table, options) => {
      const records = await realClient.listRecords(table, options);
      console.log(`[safe-preview] listRecords("${table}") → ${records.length} record(s)`);
      if (table === "SLACK CHANNELS" && records.length > 0) {
        for (const r of records) {
          console.log(`[safe-preview]   channel: "${r.fields["Name"]}" status="${r.fields["Channel status/donut"]}" intro="${r.fields["Intro type"]}"`);
        }
      }
      return records;
    },
    getRecord: async (table, recordId) => {
      const record = await realClient.getRecord(table, recordId);
      console.log(`[safe-preview] getRecord("${table}", "${recordId}") → ok`);
      return record;
    },
    createRecords: async () => {
      throw new Error(WRITE_BLOCKED);
    },
    createRecordsBatched: async () => {
      throw new Error(WRITE_BLOCKED);
    },
    updateRecords: async () => {
      throw new Error(WRITE_BLOCKED);
    },
    updateRecordsBatched: async () => {
      throw new Error(WRITE_BLOCKED);
    },
    updateRecordsBatchedDetailed: async () => {
      throw new Error(WRITE_BLOCKED);
    },
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Builds a mock SlackClient whose `listUsers()` returns users derived from
 * real Airtable member records, so the orchestrator's member-to-Slack mapping
 * works correctly.  No real Slack API calls are made.
 */
export function createSlackMockFromMembers(memberRecords: AirtableRecord[]): SlackClient {
  const users: SlackUser[] = memberRecords
    .filter((mr) => {
      const email = normalizeEmail(String(mr.fields["Slack Email"] || mr.fields["email"] || ""));
      return email && String(mr.fields["Payment"]) === "Paid";
    })
    .map((mr, i) => ({
      id: `U_SAFE_${String(i).padStart(4, "0")}`,
      email: normalizeEmail(String(mr.fields["Slack Email"] || mr.fields["email"] || "")),
      name: String(mr.fields["Name"] || "").toLowerCase().replace(/\s+/g, "."),
      realName: String(mr.fields["Name"] || ""),
      deleted: false,
      isBot: false,
      isAppUser: false,
    }));

  return {
    postMessage: async () => {
      throw new Error("Write blocked — Safe Preview mode");
    },
    getChannelHistory: async () => [],
    sendWebhook: async () => {
      throw new Error("Write blocked — Safe Preview mode");
    },
    lookupByEmail: async () => null,
    conversationsOpen: async () => {
      throw new Error("Write blocked — Safe Preview mode");
    },
    listUsers: async () => users,
    getConversationMembers: async (_channelId: string) => {
      return users.map((u) => u.id);
    },
    authTest: async () => {
      throw new Error("Write blocked — Safe Preview mode");
    },
    inviteToChannel: async () => {
      throw new Error("Write blocked — Safe Preview mode");
    },
    inviteUsersToWorkspace: async () => {
      throw new Error("Write blocked — Safe Preview mode");
    },
    deactivateUser: async () => {
      throw new Error("Write blocked — Safe Preview mode");
    },
    reactivateUser: async () => {
      throw new Error("Write blocked — Safe Preview mode");
    },
    getUserInfo: async (userId: string) => users.find((u) => u.id === userId) || null,
  };
}
