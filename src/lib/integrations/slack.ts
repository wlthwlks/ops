export interface SlackConfig {
  botToken: string;
  webhookUrl?: string;
  /** Enterprise Grid admin token (xoxp-/xoxb- with admin.users:write). Optional. */
  adminToken?: string;
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
  /** Extra profile fields for side-by-side comparison. */
  displayName?: string;
  title?: string;
  phone?: string;
  statusText?: string;
  statusEmoji?: string;
  isAdmin?: boolean;
  isOwner?: boolean;
  isRestricted?: boolean;
  isUltraRestricted?: boolean;
  tz?: string;
}

const SLACK_API = "https://slack.com/api";

interface SlackApiUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  tz?: string;
  profile?: {
    email?: string;
    display_name?: string;
    title?: string;
    phone?: string;
    status_text?: string;
    status_emoji?: string;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createSlackClient(config: SlackConfig) {
  async function slackApi(
    method: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
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

    const data = (await res.json()) as { ok?: boolean; error?: string } & Record<
      string,
      unknown
    >;
    if (!data.ok) throw new Error(`Slack API error: ${data.error}`);
    return data;
  }

  /**
   * Admin-family calls (admin.users.*) require a dedicated admin token with
   * admin.users:write on an Enterprise Grid org. Ordinary bot tokens cannot.
   */
  async function slackAdminApi(
    method: string,
    body: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    if (!config.adminToken) {
      throw new Error("SLACK_ADMIN_USER_TOKEN is not configured");
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.adminToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    };
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: "POST",
      headers,
      body: new URLSearchParams(
        Object.entries(body).map(([k, v]) => [k, String(v)])
      ).toString(),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!data.ok) throw new Error(`Slack admin API error: ${data.error}`);
    return data as Record<string, unknown>;
  }

  async function postMessage(channel: string, text: string): Promise<{ ts: string }> {
    const data = (await slackApi("chat.postMessage", { channel, text })) as {
      ts?: string;
    };
    return { ts: data.ts || "" };
  }

  async function getChannelHistory(channel: string, options?: { oldest?: string; limit?: number }): Promise<SlackMessage[]> {
    const allMessages: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const data = (await slackApi("conversations.history", { channel, oldest: options?.oldest, limit: options?.limit ?? 100, cursor })) as {
        messages?: SlackMessage[];
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      };
      allMessages.push(...(data.messages || []));
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
      const data = (await slackApi("users.lookupByEmail", { email })) as {
        user?: { id?: string; real_name?: string; name?: string };
      };
      return {
        id: data.user?.id || "",
        name: data.user?.real_name || data.user?.name || "",
      };
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
    const data = (await slackApi("conversations.open", { users: userIds.join(",") })) as {
      channel?: { id?: string };
    };
    return { channelId: data.channel?.id || "" };
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
      const data = (await slackApi("users.list", { limit: 1000, ...(cursor ? { cursor } : {}) })) as {
        members?: SlackApiUser[];
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      };
      const memberCount = data.members?.length || 0;
      allUsers.push(
        ...(data.members || []).map((u) => ({
          id: u.id,
          email: u.profile?.email || "",
          name: u.name || "",
          realName: u.real_name || "",
          deleted: Boolean(u.deleted),
          isBot: Boolean(u.is_bot),
          isAppUser: Boolean(u.is_app_user),
          displayName: u.profile?.display_name || "",
          title: u.profile?.title || "",
          phone: u.profile?.phone || "",
          statusText: u.profile?.status_text || "",
          statusEmoji: u.profile?.status_emoji || "",
          isAdmin: Boolean(u.is_admin),
          isOwner: Boolean(u.is_owner),
          isRestricted: Boolean(u.is_restricted),
          isUltraRestricted: Boolean(u.is_ultra_restricted),
          tz: u.tz || "",
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
      const data = (await slackApi("conversations.members", { channel: channelId, limit: 200, ...(cursor ? { cursor } : {}) })) as {
        members?: string[];
        has_more?: boolean;
        response_metadata?: { next_cursor?: string };
      };
      allMemberIds.push(...(data.members || []));
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

  /**
   * Invite an existing workspace user to a channel.
   * Requires channels:manage (public) or groups:write (private), and the bot
   * must already be a member of private channels.
   */
  async function inviteToChannel(channelId: string, userId: string): Promise<void> {
    await slackApi("conversations.invite", { channel: channelId, users: userId });
  }

  /**
   * Invite email addresses to the workspace. Requires an admin token with
   * admin.users:write (Enterprise Grid). channelIds auto-adds them on join.
   * Returns invite success per email.
   */
  async function inviteUsersToWorkspace(
    emails: string[],
    channelIds?: string[]
  ): Promise<Array<{ email: string; ok: boolean; error?: string }>> {
    const results: Array<{ email: string; ok: boolean; error?: string }> = [];
    for (const email of emails) {
      try {
        await slackAdminApi("admin.users.invite", {
          email,
          ...(channelIds && channelIds.length > 0
            ? { channel_ids: channelIds.join(",") }
            : {}),
        });
        results.push({ email, ok: true });
      } catch (e) {
        results.push({
          email,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return results;
  }

  /**
   * Deactivate a workspace user. Requires an admin token with admin.users:write
   * (Enterprise Grid only).
   */
  async function deactivateUser(userId: string): Promise<void> {
    await slackAdminApi("admin.users.setInactive", { user_id: userId });
  }

  /**
   * Reactivate a previously deactivated workspace user. Requires an admin
   * token with admin.users:write (Enterprise Grid only).
   */
  async function reactivateUser(userId: string): Promise<void> {
    await slackAdminApi("admin.users.setRegular", { user_id: userId });
  }

  /** Get full profile for one user (for side-by-side comparison). */
  async function getUserInfo(userId: string): Promise<SlackUser | null> {
    try {
      const data = await slackApi("users.info", { user: userId });
      const u = data.user as
        | {
            id?: string;
            name?: string;
            real_name?: string;
            deleted?: boolean;
            is_bot?: boolean;
            is_app_user?: boolean;
            is_admin?: boolean;
            is_owner?: boolean;
            is_restricted?: boolean;
            is_ultra_restricted?: boolean;
            tz?: string;
            profile?: {
              email?: string;
              display_name?: string;
              title?: string;
              phone?: string;
              status_text?: string;
              status_emoji?: string;
            };
          }
        | undefined;
      if (!u?.id) return null;
      return {
        id: u.id,
        email: u.profile?.email || "",
        name: u.name || "",
        realName: u.real_name || "",
        deleted: Boolean(u.deleted),
        isBot: Boolean(u.is_bot),
        isAppUser: Boolean(u.is_app_user),
        displayName: u.profile?.display_name || "",
        title: u.profile?.title || "",
        phone: u.profile?.phone || "",
        statusText: u.profile?.status_text || "",
        statusEmoji: u.profile?.status_emoji || "",
        isAdmin: Boolean(u.is_admin),
        isOwner: Boolean(u.is_owner),
        isRestricted: Boolean(u.is_restricted),
        isUltraRestricted: Boolean(u.is_ultra_restricted),
        tz: u.tz || "",
      };
    } catch {
      return null;
    }
  }

  return {
    postMessage,
    getChannelHistory,
    sendWebhook,
    lookupByEmail,
    conversationsOpen,
    listUsers,
    getConversationMembers,
    authTest,
    inviteToChannel,
    inviteUsersToWorkspace,
    deactivateUser,
    reactivateUser,
    getUserInfo,
  };
}

export type SlackClient = ReturnType<typeof createSlackClient>;
