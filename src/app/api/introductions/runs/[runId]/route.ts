import { NextRequest } from "next/server";
import { db } from "@/db";
import { z } from "zod";
import { requireOpsViewer, requireOpsAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk, jsonError } from "@/lib/ops/api-response";
import {
  applyPlanEdit,
  getAlternativesForMember,
  getRunDetail,
  PlanEditError,
  type PlanEdit,
} from "@/lib/introduction/plan";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { runId } = await params;
    const detail = await getRunDetail(db, runId);
    if (!detail) {
      return jsonError("PLAN_RUN_NOT_FOUND", `Run ${runId} not found`, 404);
    }

    const groupsWithAlternatives = [];
    for (const group of detail.groups) {
      const membersWithAlternatives = [];
      for (const member of group.members) {
        const alternatives = await getAlternativesForMember(db, runId, member.key);
        membersWithAlternatives.push({ ...member, alternatives });
      }
      groupsWithAlternatives.push({ ...group, members: membersWithAlternatives });
    }

    return jsonOk({ ...detail, groups: groupsWithAlternatives });
  } catch (err) {
    return handleOpsApiError(err);
  }
}

const editSchema = z.object({
  edit: z.discriminatedUnion("type", [
    z.object({ type: z.literal("remove_member"), groupId: z.string().min(1), memberKey: z.string().min(1) }),
    z.object({
      type: z.literal("replace_member"),
      groupId: z.string().min(1),
      memberKey: z.string().min(1),
      replacementKey: z.string().min(1),
    }),
    z.object({ type: z.literal("regenerate_group"), groupId: z.string().min(1) }),
    z.object({ type: z.literal("lock_group"), groupId: z.string().min(1), locked: z.boolean() }),
    z.object({ type: z.literal("regenerate_city") }),
  ]),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  try {
    await requireOpsAdmin();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const { runId } = await params;
    const body = await request.json().catch(() => null);
    const input = editSchema.parse(body ?? {});
    const result = await applyPlanEdit(db, runId, input.edit as PlanEdit);
    const detail = await getRunDetail(db, runId);
    return jsonOk({ ...result, run: detail?.run ?? null, groups: detail?.groups ?? [] });
  } catch (err) {
    if (err instanceof PlanEditError) {
      const status = err.code === "PLAN_RUN_NOT_FOUND" ? 404 : 409;
      return jsonError(err.code, err.message, status);
    }
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
