import { NextRequest, NextResponse, connection } from "next/server";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createSlackClient } from "@/lib/integrations/slack";
import { runRecurringCityIntros } from "@/lib/ops/recurring-city-intros";
import {
  getIntroductionsMode,
  IntroductionsConfigError,
} from "@/lib/introduction/runtime-mode";

import { rejectUnauthorizedCron } from "@/lib/ops/cron-auth";

export async function GET(request: NextRequest) {
  await connection();
  const denied = rejectUnauthorizedCron(request);
  if (denied) return denied;

  // Cutover gate: flip this to "false" once the unified introduction
  // engine is in production to disable the legacy recurring cron.
  if (process.env.LEGACY_RECURRING_INTROS_ENABLED === "false") {
    return NextResponse.json({
      success: true,
      skipped: true,
      reason: "legacy_recurring_intros_disabled",
    });
  }

  let introsMode;
  try {
    introsMode = getIntroductionsMode();
  } catch (e) {
    if (e instanceof IntroductionsConfigError) {
      return NextResponse.json(
        { success: false, code: e.code, message: e.message },
        { status: 500 }
      );
    }
    throw e;
  }

  const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
  const airtableBase = process.env.AIRTABLE_BASE_ID;
  const slackToken = process.env.SLACK_BOT_TOKEN;

  if (!airtableToken || !airtableBase || !slackToken) {
    return NextResponse.json({ error: "Missing credentials" }, { status: 500 });
  }

  const airtable = createAirtableClient({ apiKey: airtableToken, baseId: airtableBase });
  const slack = createSlackClient({ botToken: slackToken });

  const allowedChannelIdsRaw = process.env.RECURRING_INTROS_ALLOWED_CHANNEL_IDS;
  const allowedChannelIds = allowedChannelIdsRaw
    ? new Set(allowedChannelIdsRaw.split(",").map((s) => s.trim()).filter(Boolean))
    : null;

  const live = introsMode === "live";
  const runMode = live ? "send" : "preview";

  const result = await runRecurringCityIntros(
    {
      airtable,
      slack,
      now: () => new Date(),
      mode: runMode,
      writesEnabled: live,
      allowedChannelIds,
    },
    { dueOnly: true, requestId: `cron-${Date.now()}` }
  );

  const payload = {
    ...result,
    mode: introsMode,
    processed: true,
    sent: live && result.sentGroups > 0,
    writesPerformed: live,
  };

  if (live && !result.success) {
    return NextResponse.json(payload, { status: 500 });
  }
  if (result.partialSuccess) {
    return NextResponse.json(payload, { status: 207 });
  }

  return NextResponse.json(payload);
}
