import { requireOpsViewer, requireOpsAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk, jsonError } from "@/lib/ops/api-response";
import { db } from "@/db";
import { integrationErrors } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await requireOpsViewer();
    const url = new URL(request.url);
    const status = url.searchParams.get("status") || undefined;
    const source = url.searchParams.get("source") || undefined;
    const code = url.searchParams.get("code") || undefined;
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
    const pageSize = Math.min(100, Math.max(10, parseInt(url.searchParams.get("pageSize") || "50", 10)));

    const conditions = [];
    if (status) conditions.push(eq(integrationErrors.status, status));
    if (source) conditions.push(eq(integrationErrors.source, source));
    if (code) conditions.push(eq(integrationErrors.publicErrorCode, code));

    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await db
      .select()
      .from(integrationErrors)
      .where(where)
      .orderBy(desc(integrationErrors.lastSeenAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(integrationErrors)
      .where(where);

    return jsonOk({
      total: count,
      page,
      pageSize,
      errors: rows,
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const admin = await requireOpsAdmin();
    const body = await request.json();
    const id = String(body.id || "");
    const action = String(body.action || "");
    if (!id || !["resolve", "ignore"].includes(action)) {
      return jsonError("BAD_REQUEST", "id and action=resolve|ignore required", 400);
    }
    await db
      .update(integrationErrors)
      .set({
        status: action === "resolve" ? "resolved" : "ignored",
        resolvedAt: new Date(),
        resolvedBy: admin.userId,
        resolutionNotes: body.notes ? String(body.notes).slice(0, 2000) : null,
        updatedAt: new Date(),
      })
      .where(eq(integrationErrors.id, id));
    return jsonOk({ id, action });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
