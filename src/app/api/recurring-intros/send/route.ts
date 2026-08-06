import { NextRequest, NextResponse } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createSlackClient } from "@/lib/integrations/slack";
import { runRecurringCityIntros } from "@/lib/ops/recurring-city-intros";
import {
  getIntroductionsMode,
  IntroductionsConfigError,
  IntroductionsReadOnlyError,
  assertIntroductionsLive,
} from "@/lib/introduction/runtime-mode";
import { requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError } from "@/lib/ops/api-response";

export async function POST(request: NextRequest) {
  try {
    await requireLiveAdmin("recurring-intros/send");
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    assertIntroductionsLive("recurring-intros/send");
  } catch (e) {
    if (e instanceof IntroductionsReadOnlyError) {
      return NextResponse.json(
        {
          success: false,
          code: e.code,
          mode: "read_only",
          message:
            "Introductions are in read-only mode. No messages or database writes are allowed.",
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

  const body = await request.json();
  const { requestId, channelRecordIds, cycleDate, mock } = body;

  // Reject any mock flag — mock is removed
  if (mock) {
    return NextResponse.json(
      {
        success: false,
        code: "MOCK_REMOVED",
        message: "Mock mode has been removed. Introductions always use real data.",
      },
      { status: 400 }
    );
  }

  if (!requestId) {
    return NextResponse.json({ error: "requestId is required" }, { status: 400 });
  }

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

  const allowedChannelIdsRaw = process.env.RECURRING_INTROS_ALLOWED_CHANNEL_IDS;
  const allowedChannelIds = allowedChannelIdsRaw
    ? new Set(allowedChannelIdsRaw.split(",").map((s) => s.trim()).filter(Boolean))
    : null;

  const mode = getIntroductionsMode();

  const result = await runRecurringCityIntros(
    {
      airtable,
      slack,
      now: () => new Date(),
      mode: "send",
      writesEnabled: true,
      allowedChannelIds,
    },
    { channelRecordIds, cycleDate, requestId }
  );

  const intendedGroups = result.groupResults?.length || 0;
  const payload = { ...result, mode, readOnly: false };

  if (intendedGroups === 0 && result.sentGroups === 0 && result.alreadySentGroups === 0) {
    return NextResponse.json(payload, { status: 500 });
  }
  if (result.partialSuccess) {
    return NextResponse.json(payload, { status: 207 });
  }
  if (!result.success) {
    return NextResponse.json(payload, { status: 500 });
  }
  return NextResponse.json(payload);
}
