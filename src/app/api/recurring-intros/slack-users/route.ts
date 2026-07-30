import { NextRequest, NextResponse } from "next/server";
import { createSlackClient } from "@/lib/integrations/slack";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { checkScopes } = body;

  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    return NextResponse.json({ error: "Missing SLACK_BOT_TOKEN" }, { status: 500 });
  }

  const slack = createSlackClient({ botToken: slackToken });

  // Optional: check bot auth scopes
  let authScopes: string[] = [];
  let authTeam = "";
  let authError: string | null = null;
  if (checkScopes) {
    try {
      const auth = await slack.authTest();
      authScopes = auth.scopes;
      authTeam = auth.team;
    } catch (e) {
      authError = e instanceof Error ? e.message : String(e);
    }
  }

  const allUsers = await slack.listUsers();

  const users = allUsers.map((u) => ({
    slackId: u.id,
    name: u.realName || u.name || "(no name)",
    email: u.email || "",
    deleted: u.deleted,
    isBot: u.isBot,
    isAppUser: u.isAppUser,
  }));

  const active = users.filter((u) => !u.deleted && !u.isBot && !u.isAppUser);
  const deletedCount = users.filter((u) => u.deleted).length;
  const botCount = users.filter((u) => u.isBot).length;
  const appCount = users.filter((u) => u.isAppUser).length;

  return NextResponse.json({
    success: true,
    summary: `${users.length} total Slack users (${active.length} active, ${deletedCount} deleted, ${botCount} bots, ${appCount} app users)`,
    users,
    totalCount: users.length,
    activeCount: active.length,
    deletedCount,
    botCount,
    appCount,
    ...(checkScopes ? {
      authTeam,
      authScopes,
      authError,
    } : {}),
  });
}
