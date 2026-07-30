import { NextRequest, NextResponse } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createSlackClient } from "@/lib/integrations/slack";
import { resolveSlackEmails } from "@/lib/ops/slack-email-resolver";
import {
  assertIntroductionsLive,
  IntroductionsReadOnlyError,
  IntroductionsConfigError,
} from "@/lib/introduction/runtime-mode";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { write, updates, verbose } = body;

  const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
  const airtableBase = process.env.AIRTABLE_BASE_ID;
  const slackToken = process.env.SLACK_BOT_TOKEN;

  if (!airtableToken || !airtableBase) {
    return NextResponse.json({ error: "Missing Airtable credentials" }, { status: 500 });
  }
  if (!slackToken) {
    return NextResponse.json({ error: "Missing SLACK_BOT_TOKEN" }, { status: 500 });
  }

  const airtable = createAirtableClient({ apiKey: airtableToken, baseId: airtableBase });
  const slack = createSlackClient({ botToken: slackToken });

  // ── Write mode: batch-update approved Slack Email values ──
  if (write) {
    try {
      assertIntroductionsLive("resolve-emails/write");
    } catch (e) {
      if (e instanceof IntroductionsReadOnlyError) {
        return NextResponse.json(
          {
            success: false,
            code: e.code,
            mode: "read_only",
            message: "Introductions are in read-only mode. Airtable writes are not allowed.",
          },
          { status: 403 }
        );
      }
      if (e instanceof IntroductionsConfigError) {
        return NextResponse.json(
          { success: false, code: e.code, message: e.message },
          { status: 500 }
        );
      }
      throw e;
    }

    if (!updates || !Array.isArray(updates) || updates.length === 0) {
      return NextResponse.json({ error: "No updates provided" }, { status: 400 });
    }

    const records = updates
      .map((u: { airtableRecordId?: string; suggestedSlackEmail?: string }) => ({
        id: u.airtableRecordId || "",
        fields: { "Slack Email": u.suggestedSlackEmail || "" },
      }))
      .filter((r) => r.id);

    if (records.length === 0) {
      return NextResponse.json({ error: "No valid records to update" }, { status: 400 });
    }

    let written = 0;
    let failed = 0;
    const errors: string[] = [];

    try {
      const results = await airtable.updateRecordsBatched("MEMBERS", records);
      written = results.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed = records.length;
      errors.push(msg);
    }

    return NextResponse.json({
      success: failed === 0,
      written,
      failed,
      errors,
    });
  }

  // ── Scan mode: cross-reference Airtable members with Slack users ──
  const memberRecords = await airtable.listRecords("MEMBERS", {
    fields: ["Name", "email", "Slack Email", "City"],
    filterByFormula: 'AND({Membership} = "Active", {Payment} = "Paid")',
  });

  const slackUsers = await slack.listUsers();

  const activeSlack = slackUsers.filter((u) => !u.deleted && !u.isBot && !u.isAppUser);
  const slackWithEmail = activeSlack.filter((u) => u.email && u.email.trim()).length;
  const slackWithoutEmail = activeSlack.length - slackWithEmail;

  const slackDeleted = slackUsers.filter((u) => u.deleted).length;
  const slackBots = slackUsers.filter((u) => u.isBot).length;
  const slackAppUsers = slackUsers.filter((u) => u.isAppUser).length;

  const { suggestions, skipped } = resolveSlackEmails(memberRecords, slackUsers);

  const highCount = suggestions.filter((s) => s.confidence === "high").length;
  const lowCount = suggestions.filter((s) => s.confidence === "low").length;

  const skippedByReason: Record<string, number> = {};
  for (const s of skipped) {
    skippedByReason[s.reason] = (skippedByReason[s.reason] || 0) + 1;
  }

  return NextResponse.json({
    success: true,
    summary: `${suggestions.length} suggestions (${highCount} high, ${lowCount} low)`,
    suggestions,
    skipped,
    skippedByReason,
    memberCount: memberRecords.length,
    slackUserCount: slackUsers.length,
    slackWithEmail,
    slackWithoutEmail,
    ...(verbose ? {
      slackTotalCount: slackUsers.length,
      slackActiveCount: activeSlack.length,
      slackDeletedCount: slackDeleted,
      slackBotCount: slackBots,
      slackAppUserCount: slackAppUsers,
      slackUsersVerbose: activeSlack
        .map((u) => ({
          name: u.realName || u.name || "(no name)",
          email: u.email || "",
          slackId: u.id,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    } : {}),
  });
}
