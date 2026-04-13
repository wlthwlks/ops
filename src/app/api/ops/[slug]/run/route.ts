import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { registry } from "@/lib/registry-instance";
import { runOp } from "@/lib/run-op";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const op = registry.getBySlug(slug);

  if (!op) {
    return NextResponse.json(
      { success: false, error: `Op "${slug}" not found` },
      { status: 404 }
    );
  }

  const result = await runOp(op, db);
  const status = result.success ? 200 : 500;
  return NextResponse.json(result, { status });
}
