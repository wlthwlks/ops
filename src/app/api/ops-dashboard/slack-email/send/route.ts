import { randomUUID } from "crypto";
import { requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import { resolveMemberForOutreach } from "@/lib/ops/resolve-member-for-outreach";
import {
  buildSlackJoinEmailPreview,
  getOutreachCooldownDays,
  sendSlackJoinEmail,
} from "@/lib/ops/slack-outreach";
import { db } from "@/db";
import { memberOutreach } from "@/db/schema";
import { and, desc, eq, gte } from "drizzle-orm";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_BULK = 25;

export async function POST(request: Request) {
  try {
    const admin = await requireLiveAdmin("slack-email/send");
    const body = await request.json();
    const ids: string[] = Array.isArray(body.airtableRecordIds)
      ? body.airtableRecordIds.map(String)
      : body.airtableRecordId
        ? [String(body.airtableRecordId)]
        : [];
    const force = body.force === true;

    if (ids.length === 0) {
      return jsonError("BAD_REQUEST", "airtableRecordId(s) required", 400);
    }
    if (ids.length > MAX_BULK) {
      return jsonError(
        "BULK_LIMIT",
        `Maximum ${MAX_BULK} recipients per request`,
        400
      );
    }

    const cooldownDays = getOutreachCooldownDays();
    const cooldownSince = new Date(Date.now() - cooldownDays * 86400000);

    const results: Array<{
      airtableRecordId: string;
      status: string;
      error?: string;
      resendMessageId?: string;
    }> = [];

    for (const id of ids) {
      // Fresh authoritative validation per member — no client trust
      let member;
      try {
        const resolved = await resolveMemberForOutreach(id, { checkCooldown: false });
        member = resolved.member;
      } catch (e) {
        results.push({
          airtableRecordId: id,
          status: "failed",
          error: e instanceof Error ? e.message : "Member resolve failed",
        });
        continue;
      }

      const preview = buildSlackJoinEmailPreview(member);
      if (!preview.eligible) {
        results.push({
          airtableRecordId: id,
          status: "skipped_validation",
          error: preview.eligibilityReasons.join("; "),
        });
        continue;
      }

      try {
        const recent = await db
          .select()
          .from(memberOutreach)
          .where(
            and(
              eq(memberOutreach.airtableRecordId, id),
              eq(memberOutreach.outreachType, "slack_join"),
              eq(memberOutreach.status, "sent"),
              gte(memberOutreach.createdAt, cooldownSince)
            )
          )
          .orderBy(desc(memberOutreach.createdAt))
          .limit(1);
        if (recent.length > 0 && !force) {
          results.push({
            airtableRecordId: id,
            status: "skipped_cooldown",
            error: `Last sent ${recent[0].sentAt?.toISOString() || recent[0].createdAt.toISOString()}`,
          });
          continue;
        }
      } catch {
        /* continue without cooldown if table missing */
      }

      const idempotencyKey =
        String(body.idempotencyKey || "") ||
        `slack_join:${id}:${new Date().toISOString().slice(0, 13)}`;

      const rowId = randomUUID();
      try {
        await db.insert(memberOutreach).values({
          id: rowId,
          airtableRecordId: id,
          stripeCustomerId: member.stripeCustomerId || null,
          recipientEmail: member.primaryEmail,
          outreachType: "slack_join",
          city: member.city || null,
          cityChannelId: member.cityChannelId || null,
          allMembersChannelId: member.allMembersChannelId || null,
          status: "sending",
          sentByClerkUserId: admin.userId,
          runtimeMode: admin.mode,
          idempotencyKey: force ? `${idempotencyKey}:force:${rowId}` : idempotencyKey,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/unique|duplicate/i.test(msg)) {
          results.push({
            airtableRecordId: id,
            status: "skipped_cooldown",
            error: "Duplicate idempotency key",
          });
          continue;
        }
      }

      const sent = await sendSlackJoinEmail({ member });
      if (sent.ok) {
        try {
          await db
            .update(memberOutreach)
            .set({
              status: "sent",
              resendMessageId: sent.resendMessageId,
              sentAt: new Date(),
            })
            .where(eq(memberOutreach.id, rowId));
        } catch {
          /* ignore */
        }
        results.push({
          airtableRecordId: id,
          status: "sent",
          resendMessageId: sent.resendMessageId,
        });
      } else {
        try {
          await db
            .update(memberOutreach)
            .set({ status: "failed", error: sent.error })
            .where(eq(memberOutreach.id, rowId));
        } catch {
          /* ignore */
        }
        results.push({ airtableRecordId: id, status: "failed", error: sent.error });
      }
    }

    const sentCount = results.filter((r) => r.status === "sent").length;
    const failedCount = results.filter((r) => r.status === "failed").length;

    return jsonOk({
      results,
      sentCount,
      failedCount,
      skippedCount: results.length - sentCount - failedCount,
      mode: admin.mode,
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
