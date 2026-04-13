import { NextResponse } from "next/server";
import { db } from "@/db";
import { registry } from "@/lib/registry-instance";
import { runOp } from "@/lib/run-op";
import { opRuns } from "@/db/schema";
import { desc, eq, and } from "drizzle-orm";

function shouldRun(schedule: string, lastRunAt: string | null): boolean {
  if (!lastRunAt) return true;

  const lastRun = new Date(lastRunAt);
  const now = new Date();
  const diffMinutes = (now.getTime() - lastRun.getTime()) / 1000 / 60;

  const match = schedule.match(/^\*\/(\d+)\s/);
  if (match) {
    return diffMinutes >= parseInt(match[1], 10);
  }

  if (schedule.startsWith("0 ")) {
    return diffMinutes >= 60;
  }

  return diffMinutes >= 15;
}

export async function GET() {
  const scheduledOps = registry.getScheduled();
  const results: Array<{ slug: string; ran: boolean; result?: string }> = [];

  for (const op of scheduledOps) {
    const lastRun = db
      .select()
      .from(opRuns)
      .where(
        and(eq(opRuns.opSlug, op.slug), eq(opRuns.status, "success"))
      )
      .orderBy(desc(opRuns.startedAt))
      .limit(1)
      .get();

    if (shouldRun(op.schedule!, lastRun?.startedAt ?? null)) {
      const result = await runOp(op, db);
      results.push({ slug: op.slug, ran: true, result: result.summary });
    } else {
      results.push({ slug: op.slug, ran: false });
    }
  }

  return NextResponse.json({ results });
}
