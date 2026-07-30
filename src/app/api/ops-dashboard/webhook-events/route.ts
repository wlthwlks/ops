import { requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { db } from "@/db";
import { webhookEvents } from "@/db/schema";
import { desc, eq } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireOpsViewer();
    const url = new URL(request.url);
    const provider = url.searchParams.get("provider") || undefined;
    const status = url.searchParams.get("status") || undefined;
    let rows: unknown[] = [];
    try {
      let q = db.select().from(webhookEvents).orderBy(desc(webhookEvents.createdAt)).limit(100);
      // drizzle chaining with optional where is awkward — filter in memory for small page
      rows = await q;
      if (provider) {
        rows = (rows as Array<{ provider: string }>).filter((r) => r.provider === provider);
      }
      if (status) {
        rows = (rows as Array<{ status: string }>).filter((r) => r.status === status);
      }
    } catch {
      rows = [];
    }
    return jsonOk({ events: rows, total: (rows as unknown[]).length });
  } catch (err) {
    return handleOpsApiError(err);
  }
}

void eq;
