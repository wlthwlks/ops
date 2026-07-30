/**
 * Safer Slack Email resolve/write for the dashboard.
 * Does not overwrite non-empty Slack Email without explicit override.
 * Revalidates record before write. Requires live admin for writes.
 */
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createSlackClient } from "@/lib/integrations/slack";
import { resolveSlackEmails } from "@/lib/ops/slack-email-resolver";
import { requireLiveAdmin, requireOpsViewer } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import { resolveSlackIdentity } from "@/lib/ops/member-health";
import type { SlackUser } from "@/lib/integrations/slack";

export const runtime = "nodejs";
export const maxDuration = 120;

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  return String(v).trim();
}

function buildMaps(users: SlackUser[]) {
  const emailToUser = new Map<string, SlackUser[]>();
  const nameToUser = new Map<string, SlackUser[]>();
  const userById = new Map<string, SlackUser>();
  for (const u of users) {
    userById.set(u.id, u);
    if (u.email) {
      const e = u.email.trim().toLowerCase();
      const list = emailToUser.get(e) || [];
      list.push(u);
      emailToUser.set(e, list);
    }
    const n = (u.realName || u.name || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (n) {
      const list = nameToUser.get(n) || [];
      list.push(u);
      nameToUser.set(n, list);
    }
  }
  return { emailToUser, nameToUser, userById };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const write = body.write === true;

    const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
    const airtableBase = process.env.AIRTABLE_BASE_ID;
    const slackToken = process.env.SLACK_BOT_TOKEN;
    if (!airtableToken || !airtableBase) {
      return jsonError("CONFIG", "Missing Airtable credentials", 500);
    }
    if (!slackToken) {
      return jsonError("CONFIG", "Missing SLACK_BOT_TOKEN", 500);
    }

    const airtable = createAirtableClient({ apiKey: airtableToken, baseId: airtableBase });
    const slack = createSlackClient({ botToken: slackToken });

    if (write) {
      const admin = await requireLiveAdmin("slack/resolve/write");
      const updates: Array<{
        airtableRecordId: string;
        suggestedSlackEmail: string;
        allowOverwrite?: boolean;
      }> = Array.isArray(body.updates) ? body.updates : [];

      if (updates.length === 0) {
        return jsonError("BAD_REQUEST", "No updates provided", 400);
      }

      const written: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];
      const errors: string[] = [];

      for (const u of updates) {
        const id = u.airtableRecordId;
        const email = (u.suggestedSlackEmail || "").trim().toLowerCase();
        if (!id || !email) {
          skipped.push({ id: id || "?", reason: "Missing id or email" });
          continue;
        }
        try {
          const fresh = await airtable.getRecord("MEMBERS", id);
          const existing = fieldStr(fresh.fields, "Slack Email");
          if (existing && existing.toLowerCase() !== email && !u.allowOverwrite) {
            skipped.push({
              id,
              reason: "Non-empty Slack Email will not be overwritten without allowOverwrite",
            });
            continue;
          }
          // Confidence: suggested email must match an active slack user
          const users = await slack.listUsers();
          const maps = buildMaps(users);
          const hits = (maps.emailToUser.get(email) || []).filter(
            (x) => !x.deleted && !x.isBot && !x.isAppUser
          );
          if (hits.length !== 1) {
            skipped.push({ id, reason: "Suggested email is not a unique active Slack user" });
            continue;
          }

          await airtable.updateRecordsBatched("MEMBERS", [
            { id, fields: { "Slack Email": email } },
          ]);
          written.push(id);
          console.log(
            JSON.stringify({
              event: "slack_email_write",
              airtableRecordId: id,
              by: admin.userId,
              mode: admin.mode,
            })
          );
        } catch (e) {
          errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return jsonOk({
        written: written.length,
        writtenIds: written,
        skipped,
        errors,
        mode: admin.mode,
      });
    }

    // Scan
    await requireOpsViewer();
    const memberRecords = await airtable.listRecords("MEMBERS", {
      fields: ["Name", "email", "Slack Email", "City", "Membership", "Payment", "Service access until"],
    });
    const slackUsers = await slack.listUsers();
    const maps = buildMaps(slackUsers);

    // Enhanced validation of existing Slack Email values
    const staleSlackEmails: Array<{
      airtableRecordId: string;
      name: string;
      slackEmail: string;
      state: string;
    }> = [];
    for (const r of memberRecords) {
      const identity = resolveSlackIdentity({
        primaryEmail: fieldStr(r.fields, "email"),
        slackEmail: fieldStr(r.fields, "Slack Email"),
        name: fieldStr(r.fields, "Name"),
        ...maps,
      });
      if (
        identity.state === "stale_slack_email" ||
        identity.state === "deactivated"
      ) {
        staleSlackEmails.push({
          airtableRecordId: r.id,
          name: fieldStr(r.fields, "Name"),
          slackEmail: fieldStr(r.fields, "Slack Email"),
          state: identity.state,
        });
      }
    }

    const { suggestions, skipped } = resolveSlackEmails(memberRecords, slackUsers);

    // Only high confidence blank-field suggestions are auto-write eligible
    const writeEligible = suggestions.filter((s) => {
      const rec = memberRecords.find((r) => r.id === s.airtableRecordId);
      const existing = rec ? fieldStr(rec.fields, "Slack Email") : "";
      return s.confidence === "high" && !existing;
    });

    return jsonOk({
      suggestions,
      writeEligible,
      skipped,
      staleSlackEmails,
      memberCount: memberRecords.length,
      slackUserCount: slackUsers.length,
      note: "Non-empty Slack Email values are never overwritten without allowOverwrite.",
    });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
