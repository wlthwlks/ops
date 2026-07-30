import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { webhookEvents } from "@/db/schema";
import { and, eq, lte, or, sql } from "drizzle-orm";
import { reprocessWebhookEvent } from "@/lib/forms/webhooks/reprocess";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const batchSize = Math.min(
    50,
    Math.max(1, parseInt(process.env.INTEGRATION_RETRY_BATCH_SIZE || "20", 10))
  );

  const results: Array<{ id: string; status: string; reason: string }> = [];
  try {
    const now = new Date();
    const rows = await db
      .select()
      .from(webhookEvents)
      .where(
        and(
          or(eq(webhookEvents.status, "FAILED"), eq(webhookEvents.status, "PENDING_DEPENDENCY")),
          sql`(${webhookEvents.nextRetryAt} IS NULL OR ${webhookEvents.nextRetryAt} <= ${now})`,
          lte(webhookEvents.attemptCount, 10)
        )
      )
      .limit(batchSize);

    for (const row of rows) {
      try {
        const r = await reprocessWebhookEvent(row.id);
        results.push(r);
        const next = new Date(
          now.getTime() + Math.min(3600_000, 30_000 * 2 ** (row.attemptCount || 0))
        );
        if (r.status !== "SUCCEEDED") {
          await db
            .update(webhookEvents)
            .set({ nextRetryAt: next, updatedAt: now })
            .where(eq(webhookEvents.id, row.id));
        }
      } catch (e) {
        results.push({
          id: row.id,
          status: "FAILED",
          reason: e instanceof Error ? e.message : "reprocess failed",
        });
      }
    }
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Retry cron failed",
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    success: true,
    claimed: results.length,
    results,
  });
}

export async function GET(request: NextRequest) {
  return POST(request);
}
