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
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

  return { postMessage, getChannelHistory, sendWebhook };
}

export type SlackClient = ReturnType<typeof createSlackClient>;
