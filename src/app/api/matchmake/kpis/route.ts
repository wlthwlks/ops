import { NextResponse } from "next/server";
import { getMatchmakeKpis } from "@/lib/matchmake/kpis";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const kpis = await getMatchmakeKpis();
    return NextResponse.json(kpis);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
