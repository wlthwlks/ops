import { NextRequest, NextResponse } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createSlackClient } from "@/lib/integrations/slack";
import { runRecurringCityIntros } from "@/lib/ops/recurring-city-intros";
import {
  getIntroductionsMode,
  IntroductionsConfigError,
} from "@/lib/introduction/runtime-mode";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError } from "@/lib/ops/api-response";

export async function POST(request: NextRequest) {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  let mode;
  try {
    mode = getIntroductionsMode();
  } catch (e) {
    if (e instanceof IntroductionsConfigError) {
      return NextResponse.json(
        { success: false, code: e.code, message: e.message },
        { status: 500 }
      );
    }
    throw e;
  }

  const body = await request.json();
  const { channelRecordIds, cycleDate, dueOnly } = body;

  const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
  const airtableBase = process.env.AIRTABLE_BASE_ID;
  const slackToken = process.env.SLACK_BOT_TOKEN;

  if (!airtableToken || !airtableBase) {
    return NextResponse.json({ error: "Missing Airtable credentials" }, { status: 500 });
  }
  if (!slackToken) {
    return NextResponse.json({ error: "Missing SLACK_BOT_TOKEN" }, { status: 500 });
  }

  // Always real Airtable + Slack reads — never mock/fake users
  const airtable = createAirtableClient({ apiKey: airtableToken, baseId: airtableBase });
  const slack = createSlackClient({ botToken: slackToken });

  const requestId = crypto.randomUUID();

  const result = await runRecurringCityIntros(
    {
      airtable,
      slack,
      now: () => new Date(),
      mode: "preview",
      writesEnabled: false, // preview never writes
      allowedChannelIds: null,
    },
    { channelRecordIds, cycleDate, dueOnly, requestId }
  );

  const live = mode === "live";
  const proposedGroupCount = result.previews.reduce(
    (n, p) => n + p.proposedGroups.filter((g) => !g.unmatched).length,
    0
  );

  return NextResponse.json({
    ...result,
    mode,
    readOnly: !live,
    sendable: false, // preview never returns a sendable saved plan in this simplified flow
    planId: null,
    requestId,
    proposedGroupCount,
    summary:
      mode === "read_only"
        ? `${result.summary} (read-only — nothing saved or sent)`
        : result.summary,
  });
}
