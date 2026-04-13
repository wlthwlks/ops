import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSlackClient } from "@/lib/integrations/slack";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("SlackClient", () => {
  const client = createSlackClient({ botToken: "xoxb-test" });
  beforeEach(() => { vi.clearAllMocks(); });

  it("posts a message", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, ts: "123.456" }) });
    await client.postMessage("#general", "Hello!");
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.channel).toBe("#general");
    expect(body.text).toBe("Hello!");
  });

  it("fetches channel history", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, messages: [{ ts: "1", text: "hello" }], has_more: false }) });
    const msgs = await client.getChannelHistory("C123");
    expect(msgs).toHaveLength(1);
  });

  it("sends webhook", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const c = createSlackClient({ botToken: "xoxb-test", webhookUrl: "https://hooks.slack.com/test" });
    await c.sendWebhook("Alert!");
    expect(mockFetch.mock.calls[0][0]).toBe("https://hooks.slack.com/test");
  });

  it("throws on Slack error", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: false, error: "channel_not_found" }) });
    await expect(client.postMessage("C_BAD", "test")).rejects.toThrow("channel_not_found");
  });
});
