import { NextRequest, NextResponse } from "next/server";
import { runPineconeSync } from "@/lib/ops/sync-to-pinecone";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const city = (body as Record<string, unknown>).city;

  if (!city || typeof city !== "string") {
    return NextResponse.json(
      { success: false, error: "city is required" },
      { status: 400 }
    );
  }

  const logs: string[] = [];
  const ctx = {
    log: (msg: string) => {
      console.log(`[sync-to-pinecone] ${msg}`);
      logs.push(msg);
    },
    db: null as never,
  };

  try {
    console.log(`[sync-to-pinecone] Starting sync for city: ${city}`);
    const result = await runPineconeSync(city, ctx);
    console.log(`[sync-to-pinecone] Result:`, result.summary);

    return NextResponse.json({ ...result, logs });
  } catch (err) {
    const errorMessage = err instanceof Error
      ? `${err.message}\n${err.stack}`
      : "Unknown error";
    console.error(`[sync-to-pinecone] ERROR:`, errorMessage);
    return NextResponse.json(
      { success: false, summary: `Sync failed: ${err instanceof Error ? err.message : "Unknown error"}`, logs, error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
