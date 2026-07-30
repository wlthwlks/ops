import { NextRequest } from "next/server";
import { db } from "@/db";
import { registry } from "@/lib/registry-instance";
import { runOp } from "@/lib/run-op";
import { requireOpsAdmin, requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import { opRuns } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    const op = registry.getBySlug(slug);

    if (!op) {
      return jsonError("UNKNOWN_OPERATION", `Op "${slug}" not found`, 404);
    }

    // Client-supplied role/mode is ignored — server auth only
    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    // Reject arbitrary command fields
    if (body.command != null || body.shell != null || body.exec != null) {
      return jsonError(
        "ARBITRARY_COMMAND_REJECTED",
        "Arbitrary command execution is not allowed",
        400
      );
    }

    if (op.cliOnly || op.riskLevel === "cli_only") {
      return jsonError(
        "CLI_ONLY",
        `Operation "${slug}" is CLI-only. Use: ${op.commandEquivalent || "the documented npm script"}`,
        403
      );
    }

    if (op.deprecated || op.productionEnabled === false) {
      if (op.deprecated) {
        return jsonError(
          "DEPRECATED_OPERATION",
          `Operation "${slug}" is deprecated and cannot be executed from the dashboard`,
          403
        );
      }
    }

    const requiresAdmin = op.requiresAdmin !== false;
    const requiresLive =
      op.requiresLiveMode === true ||
      op.riskLevel === "write" ||
      op.riskLevel === "high_risk" ||
      op.riskLevel === "destructive";

    let userId: string;
    let mode: string;
    if (requiresLive) {
      const admin = await requireLiveAdmin(`ops/${slug}`);
      userId = admin.userId;
      mode = admin.mode;
    } else if (requiresAdmin) {
      const admin = await requireOpsAdmin();
      userId = admin.userId;
      mode = admin.mode;
    } else {
      const admin = await requireOpsAdmin();
      userId = admin.userId;
      mode = admin.mode;
    }

    // Block concurrent active runs of the same op
    try {
      const active = await db
        .select({ id: opRuns.id })
        .from(opRuns)
        .where(and(eq(opRuns.opSlug, slug), eq(opRuns.status, "running")))
        .limit(1);
      if (active.length > 0) {
        return jsonError(
          "OPERATION_ALREADY_RUNNING",
          `Operation "${slug}" already has an active run (#${active[0].id})`,
          409,
          { details: { runId: active[0].id }, retryable: true }
        );
      }
    } catch {
      /* schema columns may not exist yet — continue */
    }

    const variant = typeof body.variant === "string" ? body.variant : undefined;
    const parameters =
      body.parameters && typeof body.parameters === "object" && !Array.isArray(body.parameters)
        ? (body.parameters as Record<string, unknown>)
        : {};

    const result = await runOp(op, db, {
      variant,
      parameters,
      operatorClerkUserId: userId,
      runtimeMode: mode,
    });

    return jsonOk({
      ...result,
      slug,
      mode,
    }, result.success ? 200 : 500);
  } catch (err) {
    return handleOpsApiError(err);
  }
}
