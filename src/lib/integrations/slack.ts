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

const SLACK_API = "https://slack.com/api";

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

  return { postMessage, getChannelHistory, sendWebhook, lookupByEmail, conversationsOpen };
}

export type SlackClient = ReturnType<typeof createSlackClient>;
