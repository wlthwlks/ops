import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { db } = await import("@/db");
    const { opRuns } = await import("@/db/schema");
    const { desc } = await import("drizzle-orm");

    const lastRuns = await db
      .select()
      .from(opRuns)
      .orderBy(desc(opRuns.startedAt))
      .limit(20);

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
