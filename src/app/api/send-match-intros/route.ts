import { NextRequest, NextResponse } from "next/server";
import { runDailyMatchMessage, type MatchMessageResult } from "@/lib/ops/daily-match-message";
import { requireLiveAdmin, requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError } from "@/lib/ops/api-response";

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
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const modeRaw = String(body.mode || "preview").toLowerCase();
  if (modeRaw !== "preview" && modeRaw !== "send") {
    return NextResponse.json(
      { success: false, error: "mode must be preview or send", code: "INVALID_MODE" },
      { status: 400 }
    );
  }

  try {
    if (modeRaw === "send") {
      await requireLiveAdmin("send-match-intros");
    } else {
      await requireOpsViewer();
    }
  } catch (err) {
    return handleOpsApiError(err);
  }

  const {
    startDate,
    endDate,
    mode = "preview",
    emails,
    editedMessages,
    editedEmails,
    requestId,
    excludedMatches,
  } = body as {
    startDate?: string;
    endDate?: string;
    mode?: string;
    emails?: string[];
    editedMessages?: unknown;
    editedEmails?: unknown;
    requestId?: string;
    excludedMatches?: unknown;
  };

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
    requestId,
    excludedMatches
  );

  return NextResponse.json({ ...result, logs });
}
