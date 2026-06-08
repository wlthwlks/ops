import { NextRequest, NextResponse } from "next/server";
import { runDailyMatchMessage, type MatchMessageResult } from "@/lib/ops/daily-match-message";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/send-match-intros
 * Body: {
 *   startDate: "YYYY-MM-DD",
 *   endDate: "YYYY-MM-DD",
 *   mode: "preview" | "send",
 *   emails?: string[]          // optional: specific emails instead of date range
 * }
 *
 * "preview" — matches members and resolves Slack, but does NOT send messages.
 * "send"    — actually delivers Slack DMs.
 */
export async function POST(request: NextRequest) {
  const body = await request.json();
  const { startDate, endDate, mode = "preview", emails, editedMessages, editedEmails, requestId } = body;

  if (!emails?.length && (!startDate || !endDate)) {
    return NextResponse.json(
      { success: false, error: "Provide emails or startDate + endDate" },
      { status: 400 }
    );
  }

  const logs: string[] = [];
  const { db } = await import("@/db");
  const ctx = {
    log: async (msg: string) => { logs.push(msg); },
    db,
  };

  const result: MatchMessageResult = await runDailyMatchMessage(
    startDate || "",
    endDate || "",
    ctx,
    mode,
    emails,
    editedMessages,
    editedEmails,
    requestId
  );

  return NextResponse.json({ ...result, logs });
}
