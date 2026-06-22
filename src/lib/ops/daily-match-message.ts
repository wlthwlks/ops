import type { Op, OpContext } from "../types";
import { createAirtableClient } from "../integrations/airtable";
import { createPineconeClient } from "../integrations/pinecone";
import { createSlackClient } from "../integrations/slack";
import { createResendClient } from "../integrations/resend";
import { generateMatchMessage } from "../messaging/generate-match-message";
import type { MessageMember } from "../messaging/types";
import { CITIES } from "../constants";
import { db } from "@/db";
import {
  recordMatchEvent,
  recordSlackDelivery,
  recordEmailDelivery,
  type MatchInput,
} from "@/lib/matchmake/record";

/**
 * Resolve a raw city string to the list of all city names in its group.
 * Returns the group's alternatives (which includes the label) for Pinecone filtering.
 */
function getCityGroupNames(rawCity: string): string[] {
  const lower = rawCity.toLowerCase();
  const names = new Set<string>();
  for (const group of CITIES) {
    for (const alt of [group.label, ...group.alternatives]) {
      if (lower.includes(alt.toLowerCase())) {
        names.add(group.label);
        for (const a of group.alternatives) names.add(a);
        break;
      }
    }
    if (names.size > 0) break;
  }
  // Always include the raw city value — Pinecone uses exact match
  if (rawCity) names.add(rawCity);
  return Array.from(names);
}

/**
 * Parse a comma-separated env value into a deduped Set of trimmed,
 * lowercased non-empty strings. Returns an empty Set if undefined.
 */
function parseEmailEnv(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0)
  );
}

export interface DeliveryMatchMember {
  name: string;
  email: string;
  postcode: string;
  city: string;
  industry: string;
  traction: string;
  businessStage: string;
  nearbyLocation: string;
  hasBusinessDomain: boolean;
  similarityScore: number;
  onSlack: boolean;
}

export interface DeliveryResult {
  newMemberName: string;
  newMemberEmail: string;
  newMemberPostcode: string;
  newMemberCity: string;
  newMemberIndustry: string;
  newMemberTraction: string;
  newMemberNearbyLocation: string;
  newMemberBusinessStage: string;
  newMemberOnSlack: boolean;
  matches: DeliveryMatchMember[];
  slackMembersFound: string[];
  slackMembersMissing: string[];
  slackSent: boolean;
  slackChannelId: string | null;
  slackMessage: string | null;
  emailPreview: string | null;
  emailsSent: string[];
  emailsFailed: string[];
  error: string | null;
}

export interface MatchMessageResult {
  success: boolean;
  summary: string;
  deliveries: DeliveryResult[];
}

/**
 * Core logic — find new members, match them, optionally send Slack intros.
 *
 * @param mode - "preview" to match + resolve Slack without sending, "send" to deliver
 * @param emails - optional list of specific emails to process (instead of date range)
 */
export async function runDailyMatchMessage(
  startDate: string,
  endDate: string,
  ctx: OpContext,
  mode: "preview" | "send" | "send-slack" | "send-email" = "send",
  emails?: string[],
  editedMessages?: Record<string, string>,
  editedEmails?: Record<string, string>,
  requestId?: string
): Promise<MatchMessageResult> {
  // Defensive: UI should supply a requestId for non-preview modes so DB
  // tracking is idempotent end-to-end. Fall back to a fresh UUID and log a
  // warning when missing so we can spot UI/route gaps in production.
  const trackingRequestId = requestId ?? crypto.randomUUID();
  if (!requestId && mode !== "preview") {
    ctx.log(
      `WARN: runDailyMatchMessage called in mode=${mode} without a requestId — generated fallback ${trackingRequestId}`
    );
  }
  const shouldTrack = mode !== "preview";
  const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
  const airtableBase = process.env.AIRTABLE_BASE_ID;
  const pineconeKey = process.env.PINECONE_API_KEY;
  const pineconeIndex = process.env.PINECONE_INDEX_NAME;
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const resendApiKey = process.env.RESEND_API_KEY;
  const resendFromEmail = process.env.RESEND_FROM_EMAIL || "donotreply@wlthwlks.com";
  const slackInviteUrl = process.env.SLACK_WORKSPACE_INVITE_URL || process.env.SLACK_JOIN_URL || "";

  // Slack oversight recipients are added to every group DM. Configured via
  // the SLACK_OVERSIGHT_EMAILS env var (comma-separated). Empty disables it.
  const slackOversightRecipients = parseEmailEnv(process.env.SLACK_OVERSIGHT_EMAILS);

  if (!airtableToken || !airtableBase) {
    return { success: false, summary: "Missing Airtable credentials", deliveries: [] };
  }
  if (!pineconeKey || !pineconeIndex) {
    return { success: false, summary: "Missing Pinecone credentials", deliveries: [] };
  }
  if (!slackToken) {
    return { success: false, summary: "Missing SLACK_BOT_TOKEN", deliveries: [] };
  }

  const airtable = createAirtableClient({ apiKey: airtableToken, baseId: airtableBase });
  const pinecone = createPineconeClient({ apiKey: pineconeKey, indexName: pineconeIndex });
  const slack = createSlackClient({ botToken: slackToken });
  const resend = resendApiKey ? createResendClient({ apiKey: resendApiKey, fromEmail: resendFromEmail }) : null;

  // 1. Fetch members from Airtable — by email list or by date range
  let records;
  if (emails && emails.length > 0) {
    ctx.log(`Looking up ${emails.length} specific email(s)...`);
    const emailConditions = emails.map((e) => `{email} = "${e.toLowerCase()}"`);
    const formula = `AND({Membership} = "Active", {Payment} = "Paid", OR(${emailConditions.join(", ")}))`;
    records = await airtable.listRecords("Members", { filterByFormula: formula });
    ctx.log(`Found ${records.length} member(s) matching the email(s)`);
  } else {
    const dateFilter =
      startDate === endDate
        ? `IS_SAME(CREATED_TIME(), "${startDate}", "day")`
        : `AND(IS_AFTER(CREATED_TIME(), DATEADD("${startDate}", -1, "days")), IS_BEFORE(CREATED_TIME(), DATEADD("${endDate}", 1, "days")))`;
    const formula = `AND({Membership} = "Active", {Payment} = "Paid", ${dateFilter})`;
    ctx.log(`Fetching new members for ${startDate} to ${endDate}...`);
    records = await airtable.listRecords("Members", {
      filterByFormula: formula,
      sort: [{ field: "Date joined", direction: "desc" }],
    });
    ctx.log(`Found ${records.length} new member(s)`);
  }

  if (records.length === 0) {
    return { success: true, summary: "No new members in this date range", deliveries: [] };
  }

  const deliveries: DeliveryResult[] = [];
  let slackSentCount = 0;
  let skippedCount = 0;
  const runStartedAt = Date.now();

  // Per-phase timing helper. Records the elapsed ms in the supplied `timings`
  // object under `label`, returns whatever the inner promise resolves to.
  // Throws from inside still propagate normally — we don't swallow.
  async function timed<T>(label: string, timings: Record<string, number>, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      timings[label] = (timings[label] ?? 0) + (Date.now() - t0);
    }
  }

  const totalRecords = records.length;
  let recordIndex = 0;

  for (const record of records) {
    recordIndex++;
    const email = String(record.fields["email"] || "");
    if (!email) continue;

    const newMemberName = String(
      record.fields["Name"] || `${record.fields["First Name"] || ""} ${record.fields["Last Name"] || ""}`
    ).trim();

    const tag = `[${recordIndex}/${totalRecords}] ${newMemberName}`;
    const timings: Record<string, number> = {};
    const deliveryStartedAt = Date.now();
    ctx.log(`${tag}: START`);

    const newMemberPostcode = String(record.fields["post code"] || "");
    const newMemberCity = String(record.fields["City"] || "");
    const newMemberIndustry = String(record.fields["Industry"] || "");
    const newMemberTraction = String(record.fields["Revenue"] || "");

    const delivery: DeliveryResult = {
      newMemberName,
      newMemberEmail: email,
      newMemberPostcode,
      newMemberCity,
      newMemberIndustry,
      newMemberTraction,
      newMemberNearbyLocation: "",
      newMemberBusinessStage: "",
      newMemberOnSlack: false,
      matches: [],
      slackMembersFound: [],
      slackMembersMissing: [],
      slackSent: false,
      slackChannelId: null,
      slackMessage: null,
      emailPreview: null,
      emailsSent: [],
      emailsFailed: [],
      error: null,
    };

    try {
      // 2. Find this member in Pinecone
      const emailLookup = await timed("pinecone.emailLookup", timings, () =>
        pinecone.queryByVector(
          new Array(1536).fill(0),
          1,
          { email: { $eq: email.toLowerCase() } }
        )
      );

      if (emailLookup.length === 0) {
        delivery.error = "Not in Pinecone — sync may not have run yet";
        ctx.log(`${tag}: skipped (not in Pinecone) — ${Date.now() - deliveryStartedAt}ms`);
        skippedCount++;
        deliveries.push(delivery);
        continue;
      }

      const memberId = emailLookup[0].id;
      const memberRecord = await timed("pinecone.fetchById", timings, () =>
        pinecone.fetchById(memberId)
      );
      if (!memberRecord || memberRecord.values.length === 0) {
        delivery.error = "Vector not found in Pinecone";
        ctx.log(`${tag}: skipped (vector empty) — ${Date.now() - deliveryStartedAt}ms`);
        skippedCount++;
        deliveries.push(delivery);
        continue;
      }

      // 3. Find top 5 matches — filter to same city group
      const cityNames = getCityGroupNames(newMemberCity);
      const cityFilter = cityNames.length > 0
        ? { $and: [{ active: { $eq: true } }, { city: { $in: cityNames } }] }
        : { active: { $eq: true } };

      const matchResults = await timed("pinecone.matchSearch", timings, () =>
        pinecone.queryByVector(memberRecord.values, 6, cityFilter)
      );

      const matches = matchResults
        .filter((m) => m.id !== memberId)
        .slice(0, 5);

      if (matches.length === 0) {
        delivery.error = "No matches found";
        skippedCount++;
        deliveries.push(delivery);
        continue;
      }

      // Populate new member's Pinecone metadata
      delivery.newMemberNearbyLocation = String(memberRecord.metadata.nearbyLocation || "");
      delivery.newMemberBusinessStage = String(memberRecord.metadata.businessStage || "");

      const matchMembers: MessageMember[] = matches.map((m) => ({
        name: String(m.metadata.name || ""),
        email: String(m.metadata.email || ""),
        industry: String(m.metadata.industry || ""),
        businessStage: String(m.metadata.businessStage || ""),
        nearbyLocation: String(m.metadata.nearbyLocation || ""),
      }));

      // Build rich match data for UI cards
      const deliveryMatches: DeliveryMatchMember[] = matches.map((m) => ({
        name: String(m.metadata.name || ""),
        email: String(m.metadata.email || ""),
        postcode: String(m.metadata.postcode || ""),
        city: String(m.metadata.city || ""),
        industry: String(m.metadata.industry || ""),
        traction: String(m.metadata.traction || ""),
        businessStage: String(m.metadata.businessStage || ""),
        nearbyLocation: String(m.metadata.nearbyLocation || ""),
        hasBusinessDomain: Boolean(m.metadata.hasBusinessDomain),
        similarityScore: Math.round(m.score * 100) / 100,
        onSlack: false, // updated below
      }));

      // 4. Resolve Slack user IDs for all members (new + matches) — serial
      // by design (avoid burst against Slack `users:read.email` rate cap)
      const allEmails = [email, ...matchMembers.map((m) => m.email)];
      const slackUserIds = new Map<string, string>();

      await timed("slack.memberLookups", timings, async () => {
        for (const memberEmail of allEmails) {
          const slackUser = await slack.lookupByEmail(memberEmail);
          if (slackUser) {
            slackUserIds.set(memberEmail, slackUser.id);
            delivery.slackMembersFound.push(memberEmail);
          } else {
            delivery.slackMembersMissing.push(memberEmail);
          }
        }
      });

      // Mark which matches are on Slack
      delivery.newMemberOnSlack = slackUserIds.has(email);
      for (const dm of deliveryMatches) {
        dm.onSlack = slackUserIds.has(dm.email);
      }
      delivery.matches = deliveryMatches;

      ctx.log(`${tag}: ${slackUserIds.size}/${allEmails.length} on Slack (lookups ${timings["slack.memberLookups"] ?? 0}ms)`);

      // 5. Send Slack group DM to members on Slack
      // The DM includes the actual matched members plus any oversight recipients
      // (so admins can see and respond inside the same thread).
      const doSend = mode === "send" || mode === "send-slack" || mode === "send-email";
      const doSlack = mode === "send" || mode === "send-slack";
      const doEmail = mode === "send" || mode === "send-email";

      // Record the match event to DB before any delivery. Best-effort: if the
      // DB write fails we still send Slack/email — never block real-world
      // deliveries on tracking. Skip entirely in preview mode.
      // Per-event idempotency key composes the master requestId with the new
      // member's email so multiple members in one batch run don't collide.
      let matchEventId: string | null = null;
      if (shouldTrack) {
        const perEventRequestId = `${trackingRequestId}:${email.toLowerCase()}`;
        const trackedMatches: MatchInput[] = matches.map((m, idx) => ({
          email: String(m.metadata.email || ""),
          postcode: m.metadata.postcode != null ? String(m.metadata.postcode) : undefined,
          city: m.metadata.city != null ? String(m.metadata.city) : undefined,
          industry: m.metadata.industry != null ? String(m.metadata.industry) : undefined,
          rank: idx + 1,
          similarityScore: m.score,
          wasOnSlack: slackUserIds.has(String(m.metadata.email || "")),
        }));
        try {
          const recorded = await timed("db.recordMatchEvent", timings, () =>
            recordMatchEvent({
              db,
              requestId: perEventRequestId,
              mode,
              dryRun: false,
              newMember: {
                email,
                postcode: newMemberPostcode || undefined,
                city: newMemberCity || undefined,
                industry: newMemberIndustry || undefined,
              },
              matches: trackedMatches,
            })
          );
          matchEventId = recorded.matchEventId;
        } catch (recordErr) {
          const msg = recordErr instanceof Error ? (recordErr.stack || recordErr.message) : String(recordErr);
          ctx.log(`${tag}: WARN recordMatchEvent failed — ${msg}`);
        }
      }

      const sendSlackUserIds = new Map<string, string>(slackUserIds);
      if (doSend && slackOversightRecipients.size > 0) {
        await timed("slack.oversightLookups", timings, async () => {
          for (const oversightEmail of slackOversightRecipients) {
            if (sendSlackUserIds.has(oversightEmail)) continue;
            const looked = await slack.lookupByEmail(oversightEmail);
            if (looked) sendSlackUserIds.set(oversightEmail, looked.id);
          }
        });
      }

      // Generate the message for preview/sending
      const newMemberAsMsgMember: MessageMember = {
        name: newMemberName,
        email,
        industry: String(record.fields["Industry"] || ""),
        businessStage: String(memberRecord.metadata.businessStage || ""),
        nearbyLocation: String(memberRecord.metadata.nearbyLocation || ""),
      };

      const msg = generateMatchMessage({
        newMember: newMemberAsMsgMember,
        matches: matchMembers,
        format: "slack",
        slackUserIds,
      });

      delivery.slackMessage = msg.body;

      // Generate email preview (shown in UI for both preview and send)
      const emailPreviewMsg = generateMatchMessage({
        newMember: newMemberAsMsgMember,
        matches: matchMembers,
        format: "html",
        slackInviteUrl: slackInviteUrl || undefined,
        isOnSlack: slackUserIds.has(email),
      });
      delivery.emailPreview = emailPreviewMsg.body;

      if (sendSlackUserIds.size >= 2 && doSlack) {
        const slackIds = Array.from(sendSlackUserIds.values());
        // Use edited message if provided, otherwise use generated one
        const finalMessage = editedMessages?.[email] ?? msg.body;
        const { channelId } = await timed("slack.conversationsOpen", timings, () =>
          slack.conversationsOpen(slackIds)
        );
        const { ts: slackMessageTs } = await timed("slack.postMessage", timings, () =>
          slack.postMessage(channelId, finalMessage)
        );

        delivery.slackSent = true;
        delivery.slackChannelId = channelId;
        slackSentCount++;
        const oversightInGroup = Array.from(slackOversightRecipients).filter((e) => sendSlackUserIds.has(e));
        const oversightNote = oversightInGroup.length > 0 ? ` (incl. ${oversightInGroup.length} oversight)` : "";
        ctx.log(`${tag}: Slack group DM sent (${slackIds.length} members${oversightNote}) — open=${timings["slack.conversationsOpen"] ?? 0}ms post=${timings["slack.postMessage"] ?? 0}ms`);

        // Record Slack delivery metadata on the match_event. Best-effort —
        // never let a DB write failure mask a successful Slack send.
        if (shouldTrack && matchEventId) {
          try {
            await timed("db.recordSlackDelivery", timings, () =>
              recordSlackDelivery(db, matchEventId!, {
                slackChannelId: channelId,
                slackMessageTs,
                slackRecipientCount: slackIds.length,
              })
            );
          } catch (slackRecErr) {
            const m = slackRecErr instanceof Error ? (slackRecErr.stack || slackRecErr.message) : String(slackRecErr);
            ctx.log(`${tag}: WARN recordSlackDelivery failed — ${m}`);
          }
        }
      } else if (sendSlackUserIds.size >= 2 && mode === "preview") {
        ctx.log(`${tag}: ${sendSlackUserIds.size} eligible for Slack DM (preview only)`);
      } else {
        ctx.log(`${tag}: Slack skipped (<2 members on Slack)`);
      }

      // 6. Send a SINGLE introduction email to the new member (To:) with all
      // matches CC'd in. One Resend send, one rendered email, one reply-all
      // thread. Each recipient still gets a row in email_deliveries for audit.
      if (doEmail && resend) {
        // Use edited HTML if the operator changed it in the UI, otherwise generate fresh.
        const editedEmailHtml = editedEmails?.[email];
        const emailBody = editedEmailHtml ?? generateMatchMessage({
          newMember: newMemberAsMsgMember,
          matches: matchMembers,
          format: "html",
          slackInviteUrl: slackInviteUrl || undefined,
          isOnSlack: slackUserIds.has(email),
        }).body;

        const toEmail = email.toLowerCase();
        const ccEmails = Array.from(new Set(
          matchMembers
            .map((m) => (m.email || "").toLowerCase())
            .filter((e) => e && e !== toEmail)
        ));
        // Oversight BCC: same list that powers Slack oversight. Hidden from
        // matched members — they don't appear in any visible header. Dedup
        // against the visible To + Cc.
        const bccEmails = Array.from(slackOversightRecipients)
          .map((e) => e.toLowerCase())
          .filter((e) => e !== toEmail && !ccEmails.includes(e));

        // Reply-To covers the VISIBLE recipients only (new joiner + matches).
        // Oversight is invisible — leaving them out of Reply-To keeps them
        // unexposed in message headers. They still receive the email and can
        // manually reply if they want to join the thread.
        const replyToList = [toEmail, ...ccEmails];

        const result = await timed("resend.sendEmail", timings, () =>
          resend.sendEmail(
            toEmail,
            "Your WLTH WLKS Connections Are Here!",
            emailBody,
            {
              ...(ccEmails.length > 0 ? { cc: ccEmails } : {}),
              ...(bccEmails.length > 0 ? { bcc: bccEmails } : {}),
              replyTo: replyToList,
            }
          )
        );

        const allRecipients: Array<{ email: string; role: "new_member" | "match" | "oversight" }> = [
          { email: toEmail, role: "new_member" },
          ...ccEmails.map((e) => ({ email: e, role: "match" as const })),
          ...bccEmails.map((e) => ({ email: e, role: "oversight" as const })),
        ];

        if (result) {
          for (const r of allRecipients) delivery.emailsSent.push(r.email);
          const oversightNote = bccEmails.length > 0
            ? ` (BCC ${bccEmails.length} oversight)`
            : "";
          ctx.log(
            `${tag}: email sent in ${timings["resend.sendEmail"] ?? 0}ms — To: ${toEmail}` +
              (ccEmails.length > 0 ? `, Cc: ${ccEmails.join(", ")}` : "") +
              oversightNote
          );
        } else {
          for (const r of allRecipients) delivery.emailsFailed.push(r.email);
          ctx.log(`${tag}: email FAILED in ${timings["resend.sendEmail"] ?? 0}ms (1 send, ${allRecipients.length} recipients)`);
        }

        // Record one row per recipient (sharing the same resend_message_id) so
        // per-person webhook engagement can attach correctly in Phase 2.
        if (shouldTrack && matchEventId) {
          await timed("db.recordEmailDeliveries", timings, async () => {
            for (const r of allRecipients) {
              try {
                await recordEmailDelivery(db, matchEventId!, {
                  recipientEmail: r.email,
                  recipientRole: r.role,
                  resendMessageId: result?.id,
                  status: result ? "sent" : "failed",
                  error: result ? undefined : "Resend returned no id",
                });
              } catch (emailRecErr) {
                const m = emailRecErr instanceof Error ? (emailRecErr.stack || emailRecErr.message) : String(emailRecErr);
                ctx.log(`${tag}: WARN recordEmailDelivery failed for ${r.email} — ${m}`);
              }
            }
          });
        }
      }
    } catch (err) {
      delivery.error = err instanceof Error ? err.message : "Unknown error";
      // Include the stack trace verbatim so the operator can see exactly
      // which line tripped — invaluable when a single delivery in a batch
      // silently misbehaves.
      const stack = err instanceof Error ? (err.stack || err.message) : String(err);
      ctx.log(`${tag}: ERROR — ${delivery.error}\n${stack}`);
    }

    // Per-delivery timing footer: every phase + total.
    const deliveryTotalMs = Date.now() - deliveryStartedAt;
    const phaseSummary = Object.entries(timings)
      .map(([k, v]) => `${k}=${v}ms`)
      .join(" ");
    ctx.log(`${tag}: DONE in ${deliveryTotalMs}ms — ${phaseSummary || "(no phases)"}`);

    deliveries.push(delivery);
  }

  const emailTotal = deliveries.reduce((n, d) => n + d.emailsSent.length, 0);
  const runTotalMs = Date.now() - runStartedAt;
  const avgMs = deliveries.length > 0 ? Math.round(runTotalMs / deliveries.length) : 0;
  const summary = mode === "preview"
    ? `${deliveries.length} member(s) matched, ${deliveries.filter((d) => !d.error).length} ready to send, ${skippedCount} skipped — ${runTotalMs}ms (avg ${avgMs}ms)`
    : `${deliveries.length} member(s) processed, ${slackSentCount} Slack DM(s) sent, ${emailTotal} email(s) sent, ${skippedCount} skipped — ${runTotalMs}ms (avg ${avgMs}ms)`;
  ctx.log(`Done: ${summary}`);

  return { success: true, summary, deliveries };
}

/**
 * Op registered in the dashboard — no schedule (manual trigger only for now).
 */
export const dailyMatchMessage: Op = {
  slug: "daily-match-message",
  name: "Send Match Introductions",
  description:
    "Find new members, match with 3-5 others via Pinecone, and send Slack group DM introductions.",

  run: async (ctx) => {
    const today = new Date().toISOString().slice(0, 10);
    const result = await runDailyMatchMessage(today, today, ctx);
    return { success: result.success, summary: result.summary };
  },
};
