import type { Op, OpContext } from "../types";
import { createAirtableClient } from "../integrations/airtable";
import { createPineconeClient } from "../integrations/pinecone";
import { createSlackClient } from "../integrations/slack";
import { createResendClient } from "../integrations/resend";
import { generateMatchMessage } from "../messaging/generate-match-message";
import type { MessageMember } from "../messaging/types";
import { CITIES } from "../constants";

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
 * TEST MODE: Only send Slack messages to these emails.
 * All other processing (matching, lookups, message generation) runs normally
 * with real member data, but Slack DMs are only delivered when ALL recipients
 * in the group are on this allowlist. Remove this filter to go live.
 */
const SLACK_TEST_ALLOWLIST = new Set([
  "polymathic.development@gmail.com",
  "jolanta@marllm.io",
]);

const EMAIL_TEST_ALLOWLIST = new Set([
  "jolanta@wlthwlks.com",
]);

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
  editedMessages?: Record<string, string>
): Promise<MatchMessageResult> {
  const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
  const airtableBase = process.env.AIRTABLE_BASE_ID;
  const pineconeKey = process.env.PINECONE_API_KEY;
  const pineconeIndex = process.env.PINECONE_INDEX_NAME;
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const resendApiKey = process.env.RESEND_API_KEY;
  const resendFromEmail = process.env.RESEND_FROM_EMAIL || "hello@wlthwlks.com";
  const slackInviteUrl = process.env.SLACK_WORKSPACE_INVITE_URL || process.env.SLACK_JOIN_URL || "";

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

  for (const record of records) {
    const email = String(record.fields["email"] || "");
    if (!email) continue;

    const newMemberName = String(
      record.fields["Name"] || `${record.fields["First Name"] || ""} ${record.fields["Last Name"] || ""}`
    ).trim();

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
      const emailLookup = await pinecone.queryByVector(
        new Array(1536).fill(0),
        1,
        { email: { $eq: email.toLowerCase() } }
      );

      if (emailLookup.length === 0) {
        delivery.error = "Not in Pinecone — sync may not have run yet";
        ctx.log(`  ${newMemberName}: skipped (not in Pinecone)`);
        skippedCount++;
        deliveries.push(delivery);
        continue;
      }

      const memberId = emailLookup[0].id;
      const memberRecord = await pinecone.fetchById(memberId);
      if (!memberRecord || memberRecord.values.length === 0) {
        delivery.error = "Vector not found in Pinecone";
        skippedCount++;
        deliveries.push(delivery);
        continue;
      }

      // 3. Find top 5 matches — filter to same city group
      const cityNames = getCityGroupNames(newMemberCity);
      const cityFilter = cityNames.length > 0
        ? { $and: [{ active: { $eq: true } }, { city: { $in: cityNames } }] }
        : { active: { $eq: true } };

      const matchResults = await pinecone.queryByVector(
        memberRecord.values,
        6,
        cityFilter
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

      // 4. Resolve Slack user IDs for all members (new + matches)
      const allEmails = [email, ...matchMembers.map((m) => m.email)];
      const slackUserIds = new Map<string, string>();

      for (const memberEmail of allEmails) {
        const slackUser = await slack.lookupByEmail(memberEmail);
        if (slackUser) {
          slackUserIds.set(memberEmail, slackUser.id);
          delivery.slackMembersFound.push(memberEmail);
        } else {
          delivery.slackMembersMissing.push(memberEmail);
        }
      }

      // Mark which matches are on Slack
      delivery.newMemberOnSlack = slackUserIds.has(email);
      for (const dm of deliveryMatches) {
        dm.onSlack = slackUserIds.has(dm.email);
      }
      delivery.matches = deliveryMatches;

      ctx.log(`  ${newMemberName}: ${slackUserIds.size}/${allEmails.length} on Slack`);

      // 5. Send Slack group DM to members on Slack
      // TEST MODE: when sending, deliver DM to the test allowlist users only
      // (regardless of whether they're in the match group). This lets you test
      // the full flow without messaging real members. Preview shows real status.
      let sendSlackUserIds: Map<string, string>;
      const doSend = mode === "send" || mode === "send-slack" || mode === "send-email";
      const doSlack = mode === "send" || mode === "send-slack";
      const doEmail = mode === "send" || mode === "send-email";

      if (doSend) {
        // Resolve allowlist emails to Slack IDs (they may not be in the match group)
        const testIds = new Map<string, string>();
        for (const testEmail of SLACK_TEST_ALLOWLIST) {
          const existing = slackUserIds.get(testEmail);
          if (existing) {
            testIds.set(testEmail, existing);
          } else {
            const looked = await slack.lookupByEmail(testEmail);
            if (looked) testIds.set(testEmail, looked.id);
          }
        }
        sendSlackUserIds = testIds;
      } else {
        sendSlackUserIds = slackUserIds;
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
        const { channelId } = await slack.conversationsOpen(slackIds);
        await slack.postMessage(channelId, finalMessage);

        delivery.slackSent = true;
        delivery.slackChannelId = channelId;
        slackSentCount++;
        ctx.log(`  ${newMemberName}: Slack group DM sent (${slackIds.length} members)`);
      } else if (sendSlackUserIds.size >= 2 && mode === "preview") {
        ctx.log(`  ${newMemberName}: ${sendSlackUserIds.size} eligible for Slack DM (preview only)`);
      } else if (slackUserIds.size >= 2 && sendSlackUserIds.size < 2 && doSlack) {
        delivery.error = "Test mode: <2 allowlisted members on Slack";
        ctx.log(`  ${newMemberName}: Slack skipped (test mode — ${sendSlackUserIds.size} allowlisted of ${slackUserIds.size} on Slack)`);
      } else {
        ctx.log(`  ${newMemberName}: Slack skipped (<2 members on Slack)`);
      }

      // 6. Send email — TEST MODE: send to allowlisted test addresses with real match content
      if (doEmail && resend) {
        for (const testEmail of EMAIL_TEST_ALLOWLIST) {
          const emailMsg = generateMatchMessage({
            newMember: newMemberAsMsgMember,
            matches: matchMembers,
            format: "html",
            slackInviteUrl: slackInviteUrl || undefined,
            isOnSlack: false, // test recipient is not in the match group's Slack
          });

          const result = await resend.sendEmail(
            testEmail,
            "Your WLTH WLKS Connections Are Here!",
            emailMsg.body
          );

          if (result) {
            delivery.emailsSent.push(testEmail);
            ctx.log(`  ${newMemberName}: email sent to ${testEmail}`);
          } else {
            delivery.emailsFailed.push(testEmail);
            ctx.log(`  ${newMemberName}: email FAILED for ${testEmail}`);
          }
        }
      }
    } catch (err) {
      delivery.error = err instanceof Error ? err.message : "Unknown error";
      ctx.log(`  ${newMemberName}: ERROR — ${delivery.error}`);
    }

    deliveries.push(delivery);
  }

  const emailTotal = deliveries.reduce((n, d) => n + d.emailsSent.length, 0);
  const summary = mode === "preview"
    ? `${deliveries.length} member(s) matched, ${deliveries.filter((d) => !d.error).length} ready to send, ${skippedCount} skipped`
    : `${deliveries.length} member(s) processed, ${slackSentCount} Slack DM(s) sent, ${emailTotal} email(s) sent, ${skippedCount} skipped`;
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
