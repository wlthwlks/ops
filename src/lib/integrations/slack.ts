export interface SlackConfig {
  botToken: string;
  webhookUrl?: string;
}

export interface SlackMessage {
  ts: string;
  text: string;
  user?: string;
  type?: string;
}

export interface SlackUser {
  id: string;
  email: string;
  name: string;
  realName: string;
  deleted: boolean;
  isBot: boolean;
  isAppUser: boolean;
}

const SLACK_API = "https://slack.com/api";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSlackClient(config: SlackConfig) {
  async function slackApi(method: string, body: Record<string, unknown>): Promise<any> {
    // Use JSON for methods that support it, form-encoded for those that don't
    const jsonMethods = new Set([
      "chat.postMessage", "conversations.open", "conversations.history",
    ]);
    const useJson = jsonMethods.has(method);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.botToken}`,
    };

    let reqBody: string;
    if (useJson) {
      headers["Content-Type"] = "application/json";
      reqBody = JSON.stringify(body);
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      reqBody = new URLSearchParams(
        Object.entries(body).map(([k, v]) => [k, String(v)])
      ).toString();
    }

    const res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers,
      body: reqBody,
    });

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("Retry-After") || "1", 10);
      await sleep(retryAfter * 1000);
      return slackApi(method, body);
    }

    const data = await res.json();
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
    return data;
  }

  async function postMessage(channel: string, text: string): Promise<{ ts: string }> {
    const data = await slackApi("chat.postMessage", { channel, text });
    return { ts: data.ts };
  }

  async function getChannelHistory(channel: string, options?: { oldest?: string; limit?: number }): Promise<SlackMessage[]> {
    const allMessages: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const data = await slackApi("conversations.history", { channel, oldest: options?.oldest, limit: options?.limit ?? 100, cursor });
      allMessages.push(...data.messages);
      cursor = data.has_more ? data.response_metadata?.next_cursor : undefined;
    } while (cursor);
    return allMessages;
  }

  async function sendWebhook(text: string): Promise<void> {
    if (!config.webhookUrl) throw new Error("Webhook URL not configured");
    await fetch(config.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  }

  /**
   * Look up a Slack user by email. Returns null if the user is not in the workspace.
   * Requires the `users:read.email` bot scope.
   */
  async function lookupByEmail(email: string): Promise<{ id: string; name: string } | null> {
    try {
      const data = await slackApi("users.lookupByEmail", { email });
      return { id: data.user.id, name: data.user.real_name || data.user.name };
    } catch (err) {
      // users_not_found is expected for members not in Slack
      if (err instanceof Error && err.message.includes("users_not_found")) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Open a group DM (multi-person IM) with the given user IDs.
   * Requires the `mpim:write` bot scope. Max 8 users.
   */
  async function conversationsOpen(userIds: string[]): Promise<{ channelId: string }> {
    const data = await slackApi("conversations.open", { users: userIds.join(",") });
    return { channelId: data.channel.id };
  }

  /**
   * List all users in the workspace with pagination.
   * Requires `users:read` and `users:read.email` bot scopes.
   */
  async function listUsers(): Promise<SlackUser[]> {
    const allUsers: SlackUser[] = [];
    let cursor: string | undefined;
    let page = 0;
    do {
      page++;
      const data = await slackApi("users.list", { limit: 200, ...(cursor ? { cursor } : {}) });
      const memberCount = data.members?.length || 0;
      allUsers.push(
        ...(data.members || []).map((u: any) => ({
          id: u.id,
          email: u.profile?.email || "",
          name: u.name || "",
          realName: u.real_name || "",
          deleted: Boolean(u.deleted),
          isBot: Boolean(u.is_bot),
          isAppUser: Boolean(u.is_app_user),
        }))
      );
      const nextCursor = data.response_metadata?.next_cursor;
      console.log(
        `[Slack] users.list page ${page}: ${memberCount} users (cumulative: ${allUsers.length}), has_more: ${data.has_more}, next_cursor: ${nextCursor ? "present" : "missing"}`
      );
      cursor = data.response_metadata?.next_cursor;
    } while (cursor);
    console.log(`[Slack] users.list done: ${allUsers.length} total users across ${page} page(s)`);
    return allUsers;
  }

  /**
   * Get members of a conversation (channel) with pagination.
   * Requires `channels:read` for public channels or `groups:read` for private channels.
   */
  async function getConversationMembers(channelId: string): Promise<string[]> {
    const allMemberIds: string[] = [];
    let cursor: string | undefined;
    do {
      const data = await slackApi("conversations.members", { channel: channelId, limit: 200, ...(cursor ? { cursor } : {}) });
      allMemberIds.push(...data.members);
      cursor = data.has_more ? data.response_metadata?.next_cursor : undefined;
    } while (cursor);
    return allMemberIds;
  }

  /**
   * Check bot auth and return scopes from the X-OAuth-Scopes response header.
   * Requires no special scope — works with any valid token.
   */
  async function authTest(): Promise<{ url: string; team: string; scopes: string[] }> {
    const res = await fetch(`${SLACK_API}/auth.test`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    const scopesHeader = res.headers.get("x-oauth-scopes") || "";
    const scopes = scopesHeader.split(",").map((s) => s.trim()).filter(Boolean);
    return {
      url: data.url || "",
      team: data.team || "",
      scopes,
    };
  }

  return { postMessage, getChannelHistory, sendWebhook, lookupByEmail, conversationsOpen, listUsers, getConversationMembers, authTest };
}

export type SlackClient = ReturnType<typeof createSlackClient>;
