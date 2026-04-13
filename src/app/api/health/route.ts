import { NextResponse } from "next/server";
import { db } from "@/db";
import { opRuns } from "@/db/schema";
import { desc } from "drizzle-orm";

export async function GET() {
  try {
    const lastRuns = db
      .select()
      .from(opRuns)
      .orderBy(desc(opRuns.startedAt))
      .limit(20)
      .all();

    const failedOps = lastRuns.filter((r) => r.status === "failed");

    return NextResponse.json({
      status: "ok",
      recentRuns: lastRuns.length,
      failedOps: failedOps.map((r) => r.opSlug),
    });
  } catch (error) {
    return NextResponse.json(
      { status: "error", message: "Database unavailable" },
      { status: 500 }
    );
  }
}
