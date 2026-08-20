import { requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import {
  getMemberPauseSnapshot,
  pauseSnapshotFromRecord,
  resumeMemberIntros,
  setMemberPause,
} from "@/lib/ops/member-pause";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BULK = 25;

export async function POST(request: Request) {
  try {
    const admin = await requireLiveAdmin("members/pause");
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

    if (action === "preview") {
      const snapshots = [];
      for (const id of ids) {
        const snapshot = await getMemberPauseSnapshot(id);
        snapshots.push(
          snapshot ?? {
            airtableRecordId: id,
            found: false,
            state: "unknown",
            isPaused: false,
          }
        );
      }
      return jsonOk({ snapshots, mode: admin.mode });
    }

    if (action === "pause") {
      const pauseUntil =
        body.pauseUntil != null && String(body.pauseUntil).trim() !== ""
          ? String(body.pauseUntil).trim()
          : null;
      const results = [];
      for (const id of ids) {
        try {
          const { record, warnings } = await setMemberPause({
            airtableRecordId: id,
            clerkUserId: admin.userId,
            mode: admin.mode,
            pauseUntil,
          });
          results.push({
            airtableRecordId: id,
            ok: true,
            warnings,
            snapshot: pauseSnapshotFromRecord(record),
          });
        } catch (err) {
          results.push({
            airtableRecordId: id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return jsonOk({ results, mode: admin.mode });
    }

    if (action === "resume") {
      const results = [];
      for (const id of ids) {
        try {
          const { record } = await resumeMemberIntros({
            airtableRecordId: id,
            clerkUserId: admin.userId,
            mode: admin.mode,
          });
          results.push({
            airtableRecordId: id,
            ok: true,
            snapshot: pauseSnapshotFromRecord(record),
          });
        } catch (err) {
          results.push({
            airtableRecordId: id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return jsonOk({ results, mode: admin.mode });
    }

    return jsonError("BAD_REQUEST", `Unknown action: ${action}`, 400);
  } catch (err) {
    return handleOpsApiError(err);
  }
}
