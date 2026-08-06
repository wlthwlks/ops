import { NextResponse } from "next/server";
import { getMatchmakeKpis } from "@/lib/matchmake/kpis";
import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError } from "@/lib/ops/api-response";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireOpsViewer();
    const kpis = await getMatchmakeKpis();
    return NextResponse.json(kpis);
  } catch (error) {
    const ops = handleOpsApiError(error);
    if (ops.status === 401 || ops.status === 403) return ops;
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
