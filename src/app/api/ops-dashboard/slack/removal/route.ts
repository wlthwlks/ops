import { randomUUID } from "crypto";
import { requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import {
  buildRemovalPlan,
  detectSlackRemovalCapabilities,
  executeChannelRemovals,
  executeWorkspaceDeactivation,
} from "@/lib/ops/slack-removal";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BULK = 25;

export async function POST(request: Request) {
  try {
    const admin = await requireLiveAdmin("slack/removal");
    const body = await request.json();
    const action = String(body.action || "preview");
    const ids: string[] = Array.isArray(body.airtableRecordIds)
      ? body.airtableRecordIds.map(String)
      : body.airtableRecordId
        ? [String(body.airtableRecordId)]
        : [];

    if (ids.length === 0) {
      return jsonError("BAD_REQUEST", "airtableRecordId(s) required", 400);
    }
    if (ids.length > MAX_BULK) {
      return jsonError("BULK_LIMIT", `Maximum ${MAX_BULK} members per request`, 400);
    }

    const capabilities = await detectSlackRemovalCapabilities();

    if (action === "preview") {
      const plans = [];
      for (const id of ids) {
        plans.push(await buildRemovalPlan(id, capabilities));
      }
      return jsonOk({ plans, capabilities, mode: admin.mode });
    }

    if (action === "deactivate") {
      return jsonError(
        "CAPABILITY_UNAVAILABLE",
        capabilities.deactivateReason ||
          "Workspace deactivation is not available with the connected Slack credentials.",
        403,
        { details: { capabilities }, retryable: false }
      );
    }

    if (action === "remove_channels") {
      if (!capabilities.canKickFromChannels) {
        return jsonError(
          "SLACK_SCOPE_MISSING",
          "Bot cannot kick users from channels. Need channels:write and/or groups:write, and bot must be in the channel.",
          403,
          { details: { capabilities }, retryable: false }
        );
      }

      const channelIds: string[] = Array.isArray(body.channelIds)
        ? body.channelIds.map(String)
        : [];
      const results = [];
      for (const id of ids) {
        const plan = await buildRemovalPlan(id, capabilities);
        const targets =
          channelIds.length > 0
            ? channelIds
            : plan.channelsToRemove.map((c) => c.id);
        const idempotencyKey =
          String(body.idempotencyKey || "") ||
          `remove:${id}:${targets.sort().join(",")}:${new Date().toISOString().slice(0, 13)}`;
        const result = await executeChannelRemovals({
          airtableRecordId: id,
          channelIds: targets,
          clerkUserId: admin.userId,
          runtimeMode: admin.mode,
          idempotencyKey: ids.length > 1 ? `${idempotencyKey}:${randomUUID().slice(0, 8)}` : idempotencyKey,
        });
        results.push({ airtableRecordId: id, ...result });
      }
      return jsonOk({ results, capabilities, mode: admin.mode });
    }

    if (action === "remove_and_deactivate") {
      // Kick from WLTH channels first, then deactivate the workspace account
      // when an admin token is available. Channel removal still succeeds
      // without deactivation capability.
      const channelIds: string[] = Array.isArray(body.channelIds)
        ? body.channelIds.map(String)
        : [];
      const results = [];
      for (const id of ids) {
        const plan = await buildRemovalPlan(id, capabilities);
        const targets =
          channelIds.length > 0
            ? channelIds
            : plan.channelsToRemove.map((c) => c.id);
        const baseKey =
          String(body.idempotencyKey || "") ||
          `remove_all:${id}:${targets.sort().join(",")}:${new Date().toISOString().slice(0, 13)}`;
        const suffix =
          ids.length > 1 ? `:${randomUUID().slice(0, 8)}` : "";

        const kickResult =
          targets.length > 0
            ? await executeChannelRemovals({
                airtableRecordId: id,
                channelIds: targets,
                clerkUserId: admin.userId,
                runtimeMode: admin.mode,
                idempotencyKey: `${baseKey}:kick${suffix}`,
              })
            : { status: "no_channels", results: [] };

        let deactivateStatus: string | undefined;
        let deactivateError: string | undefined;
        if (
          capabilities.canDeactivateWorkspaceUser &&
          plan.eligible &&
          plan.slackUserId
        ) {
          const deactivated = await executeWorkspaceDeactivation({
            airtableRecordId: id,
            clerkUserId: admin.userId,
            runtimeMode: admin.mode,
            idempotencyKey: `${baseKey}:deactivate${suffix}`,
          });
          deactivateStatus = deactivated.status;
          deactivateError = deactivated.error;
        } else if (!capabilities.canDeactivateWorkspaceUser) {
          deactivateStatus = "deactivate_unavailable";
          deactivateError = capabilities.deactivateReason;
        }

        results.push({
          airtableRecordId: id,
          status: kickResult.status,
          kickResults: kickResult.results,
          kickError: kickResult.error,
          deactivateStatus,
          deactivateError,
          slackUserId: plan.slackUserId,
          memberName: plan.memberName,
          ok:
            ["completed", "no_channels", "already_removed"].includes(kickResult.status) &&
            (deactivateStatus === "completed" ||
              deactivateStatus === "deactivate_unavailable"),
        });
      }
      return jsonOk({ results, capabilities, mode: admin.mode });
    }

    return jsonError("BAD_REQUEST", `Unknown action: ${action}`, 400);
  } catch (err) {
    return handleOpsApiError(err);
  }
}
