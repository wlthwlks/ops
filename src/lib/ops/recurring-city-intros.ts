import { DateTime } from "luxon";
import type { AirtableClient, AirtableRecord } from "../integrations/airtable";
import type { SlackClient, SlackUser } from "../integrations/slack";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecurringChannelConfig {
  airtableRecordId: string;
  name: string;
  citiesRecordId: string;
  cityName: string;
  slackChannelId: string;
  introType: string;
  groupSize: number;
  strictGroupSize: boolean;
  introFrequencyWeeks: number;
  nextIntroductionDate: string | null;
  introLocalTime: string;
  timezone: string;
  introMessageTemplate: string;
  schedulingMode: string;
  googleCalendarEnabled: boolean;
  outlookEnabled: boolean;
  meetingDurationMinutes: number;
  autoScheduleMeeting: boolean;
  channelStatus: string;
}

export interface RecurringMember {
  airtableRecordId: string;
  name: string;
  email: string;
  slackUserId: string | null;
  city: string;
  recurringIntroStatus: string;
  recurringPauseUntil: string | null;
  payment: string;
  membership: string;
  serviceAccessUntil: string | null;
  firstIntroductionStatus: string;
}

export interface RecurringGroup {
  members: RecurringMember[];
  unmatched: boolean;
}

export interface RecurringPreview {
  channelName: string;
  cityName: string;
  cycleId: string;
  config: RecurringChannelConfig;
  slackUserCount: number;
  eligibleMembers: RecurringMember[];
  proposedGroups: RecurringGroup[];
  groupSizes: number[];
  unmatchedMembers: RecurringMember[];
  excludedByReason: Record<string, RecurringMember[]>;
  membersNotFoundInAirtable: string[];
  airtableMembersNotOnSlack: string[];
  recentRepeatWarnings: string[];
  calendarWarning: string | null;
  renderedMessages: string[];
  isDue: boolean;
  channelMembershipError: string | null;
}

export interface SkippedChannel {
  name: string;
  reason: string;
}

export interface GroupResult {
  groupId: string;
  channelName: string;
  cityName: string;
  memberNames: string[];
  status: "sent" | "failed" | "tracking_failed" | "blocked" | "already_sent" | "simulated" | "skipped";
  slackConversationId: string | null;
  slackMessageTs: string | null;
  sendError: string | null;
  trackingError: string | null;
  alreadySent: boolean;
  simulated: boolean;
}

export interface RecurringRunResult {
  success: boolean;
  partialSuccess: boolean;
  summary: string;
  previews: RecurringPreview[];
  sentGroups: number;
  failedGroups: number;
  trackingFailedGroups: number;
  alreadySentGroups: number;
  simulatedGroups: number;
  blockedGroups: number;
  skippedChannels: SkippedChannel[];
  groupResults: GroupResult[];
}

export interface RecurringDeps {
  airtable: AirtableClient;
  slack: SlackClient;
  now: () => Date;
  /** preview = compute only; send = may deliver when writesEnabled */
  mode: "preview" | "send";
  /**
   * When true, Airtable writes and Slack delivery are allowed (live mode only).
   * Always false for preview / read_only.
   */
  writesEnabled: boolean;
  allowedChannelIds: Set<string> | null;
  db?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeCityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function frequencyLabel(weeks: number): string {
  if (weeks === 1) return "week";
  if (weeks === 2) return "two weeks";
  if (weeks === 3) return "three weeks";
  if (weeks === 4) return "four weeks";
  return `${weeks} weeks`;
}

// Seeded PRNG (mulberry32)
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToSeed(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0;
  }
  return hash;
}

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Pure business logic
// ---------------------------------------------------------------------------

export function isMemberEligible(member: RecurringMember, cycleDate: Date): { eligible: boolean; reason: string | null } {
  if (member.firstIntroductionStatus === "Pending" || member.firstIntroductionStatus === "Failed") {
    return { eligible: false, reason: "Waiting for first introduction" };
  }

  const serviceAccessOk = member.payment === "Paid" && member.membership === "Active";
  if (!serviceAccessOk) {
    if (member.serviceAccessUntil) {
      const until = new Date(member.serviceAccessUntil);
      if (cycleDate >= until) {
        return { eligible: false, reason: "Service access expired" };
      }
    } else {
      return { eligible: false, reason: "Inactive or unpaid" };
    }
  }

  const status = (member.recurringIntroStatus || "").trim();
  if (status === "" || status === "Active") return { eligible: true, reason: null };
  if (status === "Excluded") return { eligible: false, reason: "Excluded" };
  if (status === "Paused") {
    if (!member.recurringPauseUntil) return { eligible: false, reason: "Paused" };
    const pauseEnd = new Date(member.recurringPauseUntil);
    if (cycleDate >= pauseEnd) return { eligible: true, reason: null };
    return { eligible: false, reason: "Paused" };
  }
  return { eligible: false, reason: "Unknown status" };
}

export function calculateBalancedGroupSizes(
  totalMembers: number,
  targetSize: number,
  strict: boolean
): { sizes: number[]; unmatched: number } {
  // Clamp target
  const t = Math.max(2, Math.min(8, targetSize || 3));

  if (totalMembers === 0) return { sizes: [], unmatched: 0 };
  // One member can never form a group (min size is 2)
  if (totalMembers === 1) return { sizes: [], unmatched: 1 };

  if (strict) {
    const groups = Math.floor(totalMembers / t);
    const unmatched = totalMembers - groups * t;
    return { sizes: Array(groups).fill(t), unmatched };
  }

  // Non-strict: distribute members across groups of sizes 2-8, never leaving 1
  if (totalMembers <= t) {
    // 2..t members → single group
    return { sizes: [totalMembers], unmatched: 0 };
  }

  const numGroups = Math.round(totalMembers / t);
  const baseSize = Math.floor(totalMembers / numGroups);
  let remainder = totalMembers - baseSize * numGroups;

  const sizes: number[] = [];
  for (let i = 0; i < numGroups; i++) {
    const size = baseSize + (remainder > 0 ? 1 : 0);
    sizes.push(Math.min(size, 8)); // cap at 8
    if (remainder > 0) remainder--;
  }

  // Verify no group of 1
  for (const s of sizes) {
    if (s < 2) return { sizes: [], unmatched: totalMembers };
  }

  return { sizes, unmatched: 0 };
}

export function buildCycleId(cityName: string, date: Date): string {
  const normalized = normalizeCityName(cityName);
  const dateStr = date.toISOString().slice(0, 10);
  return `recurring-${normalized}-${dateStr}`;
}

export function isChannelDue(config: RecurringChannelConfig, now: Date): boolean {
  if (!config.nextIntroductionDate) return false;
  if (config.channelStatus !== "Active") return false;
  if (config.introType !== "Standard") return false;

  try {
    const tz = config.timezone || "UTC";
    const nextDate = DateTime.fromISO(config.nextIntroductionDate, { zone: tz });
    const [hours, minutes] = (config.introLocalTime || "09:00").split(":").map(Number);
    const nextDateTime = nextDate.set({ hour: hours || 9, minute: minutes || 0, second: 0, millisecond: 0 });
    const nowZoned = DateTime.fromJSDate(now, { zone: tz });
    return nowZoned >= nextDateTime;
  } catch {
    return false;
  }
}

export function renderRecurringMessage(
  template: string,
  participants: string,
  city: string,
  freqLabel: string,
  meetingDuration: number | null
): string {
  let msg = template || "";
  msg = msg.replace(/\{\{participants\}\}/g, participants);
  msg = msg.replace(/\{\{city\}\}/g, city);
  msg = msg.replace(/\{\{frequency_label\}\}/g, freqLabel);
  msg = msg.replace(/\{\{meeting_duration\}\}/g, meetingDuration ? `${meetingDuration} minutes` : "TBD");

  if (!template.includes("{{participants}}") && participants) {
    msg = `${participants}\n\n${msg}`;
  }

  return msg.trim();
}

function getRepeatWarnings(
  groups: RecurringGroup[],
  recentPairs: Map<string, Set<string>>
): string[] {
  const warnings: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group.unmatched) continue;
    const emails = group.members.map((m) => normalizeEmail(m.email));
    for (let a = 0; a < emails.length; a++) {
      for (let b = a + 1; b < emails.length; b++) {
        const pairKey = [emails[a], emails[b]].sort().join("|");
        const reversePair = recentPairs.get(pairKey);
        if (reversePair) {
          warnings.push(
            `Group ${i + 1}: ${group.members[a].name} and ${group.members[b].name} were recently introduced together.`
          );
        }
      }
    }
  }
  return warnings;
}

export function buildRecurringGroups(
  eligibleMembers: RecurringMember[],
  targetSize: number,
  strict: boolean,
  cycleId: string,
  recentPairs: Map<string, Set<string>> = new Map()
): { groups: RecurringGroup[]; unmatched: RecurringMember[]; warnings: string[] } {
  const seed = hashStringToSeed(cycleId);
  const { sizes } = calculateBalancedGroupSizes(
    eligibleMembers.length,
    targetSize,
    strict
  );

  let bestGroups: RecurringGroup[] = [];
  let bestUnmatched: RecurringMember[] = [];
  let bestWarnings: string[] = [];
  let bestRepeatCount = Infinity;
  let bestUnmatchedCount = Infinity;

  const ATTEMPTS = 10;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const attemptSeed = seed + attempt;
    const shuffled = seededShuffle(eligibleMembers, attemptSeed);
    const groups: RecurringGroup[] = [];
    let offset = 0;
    for (const size of sizes) {
      groups.push({ members: shuffled.slice(offset, offset + size), unmatched: false });
      offset += size;
    }
    const unmatched = shuffled.slice(offset);

    const warnings = getRepeatWarnings(groups, recentPairs);
    const repeatCount = warnings.length;
    const unmatchedCount = unmatched.length;

    if (
      repeatCount < bestRepeatCount ||
      (repeatCount === bestRepeatCount && unmatchedCount < bestUnmatchedCount)
    ) {
      bestGroups = groups;
      bestUnmatched = unmatched;
      bestWarnings = warnings;
      bestRepeatCount = repeatCount;
      bestUnmatchedCount = unmatchedCount;
    }
  }

  if (bestUnmatched.length > 0) {
    bestGroups.push({ members: bestUnmatched, unmatched: true });
  }

  return { groups: bestGroups, unmatched: bestUnmatched, warnings: bestWarnings };
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function runRecurringCityIntros(
  deps: RecurringDeps,
  options: {
    channelRecordIds?: string[];
    cycleDate?: string;
    dueOnly?: boolean;
    requestId?: string;
  } = {}
): Promise<RecurringRunResult> {
  const { airtable, slack, now: nowFn, mode, writesEnabled, allowedChannelIds } = deps;
  const cycleDate = options.cycleDate ? new Date(options.cycleDate) : nowFn();
  const previews: RecurringPreview[] = [];
  const skippedChannels: SkippedChannel[] = [];
  let sentGroups = 0;
  let failedGroups = 0;
  let trackingFailedGroups = 0;
  let alreadySentGroups = 0;
  const simulatedGroups = 0;
  let blockedGroups = 0;
  const groupResults: GroupResult[] = [];
  // Delivery only when send mode AND writes enabled (INTRODUCTIONS_MODE=live)
  const canDeliver = mode === "send" && writesEnabled;

  // 1. Fetch Slack channels
  const channelFilter = options.channelRecordIds?.length
    ? `OR(${options.channelRecordIds.map((id) => `RECORD_ID() = "${id}"`).join(", ")})`
    : undefined;
  const channelRecords = await airtable.listRecords("SLACK CHANNELS", {
    filterByFormula: channelFilter,
    fields: [
      "Name", "Cities", "group size", "Channel status/donut", "Slack Channel ID",
      "Intro type", "Strict group size", "Intro frequency weeks", "Next introduction date",
      "Intro local time", "Timezone", "Intro message template", "Scheduling mode",
      "Google Calendar enabled", "Outlook enabled", "Meeting duration minutes",
      "Auto schedule meeting",
    ],
  });

  // 2. Fetch Cities table for display names
  const cityRecords = await airtable.listRecords("ALL CITIES");
  const cityIdToName = new Map<string, string>();
  for (const cr of cityRecords) {
    cityIdToName.set(
      cr.id,
      String(cr.fields["City"] || cr.fields["Name"] || cr.fields["name"] || cr.id)
    );
  }

  // 3. Fetch Members
  const memberRecords = await airtable.listRecords("MEMBERS", {
    fields: [
      "Name", "email", "Slack Email", "Payment", "Membership", "City",
      "Recurring intro status", "Recurring pause until",
      "Service access until", "First introduction status",
    ],
  });

  const emailToMemberRecord = new Map<string, AirtableRecord>();
  for (const mr of memberRecords) {
    const primaryEmail = normalizeEmail(
      String(mr.fields["Slack Email"] || mr.fields["email"] || "")
    );
    if (primaryEmail) emailToMemberRecord.set(primaryEmail, mr);
  }

  // 4. Fetch Slack users (once) — always real Slack data, never fake users
  let allSlackUsers: SlackUser[] = [];
  try {
    allSlackUsers = await slack.listUsers();
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error("[RecurringIntros] Failed to list Slack users:", errMsg);
    return {
      success: false,
      partialSuccess: false,
      summary: `Failed to list Slack users: ${errMsg}`,
      previews,
      sentGroups,
      failedGroups,
      trackingFailedGroups: 0,
      alreadySentGroups: 0,
      simulatedGroups: 0,
      blockedGroups: 0,
      skippedChannels,
      groupResults: [],
    };
  }

  const slackIdToUser = new Map<string, SlackUser>();
  const emailToSlackUser = new Map<string, SlackUser>();
  for (const u of allSlackUsers) {
    if (u.deleted || u.isBot || u.isAppUser) continue;
    slackIdToUser.set(u.id, u);
    const email = normalizeEmail(u.email);
    if (email) emailToSlackUser.set(email, u);
  }

  // 5. Process each channel
  console.log(`[RecurringIntros] Processing ${channelRecords.length} channel(s), ${memberRecords.length} member(s), ${allSlackUsers.length} Slack user(s)`);
  for (const channelRecord of channelRecords) {
    const f = channelRecord.fields;
    const channelName = String(f["Name"] || "");
    const channelStatus = String(f["Channel status/donut"] || "");
    const introType = String(f["Intro type"] || "");
    const slackChannelId = String(f["Slack Channel ID"] || "");
    const citiesRaw = f["Cities"];
    const citiesArray: unknown[] = Array.isArray(citiesRaw) ? citiesRaw : (citiesRaw != null ? [citiesRaw] : []);
    const citiesRecordId = String(citiesArray[0] || "");
    const cityName = cityIdToName.get(citiesRecordId) || citiesRecordId;

    // Filter: only Active + Standard + not Virtual
    if (channelStatus !== "Active") {
      console.log(`[RecurringIntros] Skipping "${channelName}" — status "${channelStatus}" (not Active)`);
      skippedChannels.push({ name: channelName, reason: `Not Active (status="${channelStatus}")` });
      continue;
    }
    if (introType !== "Standard") {
      console.log(`[RecurringIntros] Skipping "${channelName}" — intro type "${introType}" (not Standard)`);
      skippedChannels.push({ name: channelName, reason: `Not Standard (intro type="${introType}")` });
      continue;
    }
    if (channelName.toLowerCase().includes("virtual")) {
      console.log(`[RecurringIntros] Skipping "${channelName}" — contains "virtual"`);
      skippedChannels.push({ name: channelName, reason: "Virtual channel" });
      continue;
    }

    // If specific channels requested, skip non-matching
    if (options.channelRecordIds?.length && !options.channelRecordIds.includes(channelRecord.id)) {
      skippedChannels.push({ name: channelName, reason: "Not in selected channel IDs" });
      continue;
    }

    const config: RecurringChannelConfig = {
      airtableRecordId: channelRecord.id,
      name: channelName,
      citiesRecordId,
      cityName,
      slackChannelId,
      introType,
      groupSize: Number(f["group size"]) || 3,
      strictGroupSize: Boolean(f["Strict group size"]),
      introFrequencyWeeks: Number(f["Intro frequency weeks"]) || 1,
      nextIntroductionDate: f["Next introduction date"] ? String(f["Next introduction date"]) : null,
      introLocalTime: String(f["Intro local time"] || "09:00"),
      timezone: String(f["Timezone"] || "UTC"),
      introMessageTemplate: String(f["Intro message template"] || ""),
      schedulingMode: String(f["Scheduling mode"] || ""),
      googleCalendarEnabled: Boolean(f["Google Calendar enabled"]),
      outlookEnabled: Boolean(f["Outlook enabled"]),
      meetingDurationMinutes: Number(f["Meeting duration minutes"]) || 0,
      autoScheduleMeeting: Boolean(f["Auto schedule meeting"]),
      channelStatus,
    };

    const isDue = isChannelDue(config, cycleDate);
    if (options.dueOnly && !isDue) {
      skippedChannels.push({ name: channelName, reason: "Not due yet" });
      continue;
    }

    const cycleId = buildCycleId(cityName, cycleDate);
    const freqLabel = frequencyLabel(config.introFrequencyWeeks);

    // Calendar warning
    let calendarWarning: string | null = null;
    if (config.googleCalendarEnabled || config.outlookEnabled || config.autoScheduleMeeting) {
      calendarWarning =
        "Calendar integration is configured in Airtable but is not supported by the Ops replacement yet. Members must organise the walk manually.";
    }

    // Get channel members — real Slack membership only
    let channelMemberIds: string[] = [];
    let channelMembershipError: string | null = null;
    if (!slackChannelId) {
      channelMembershipError = `Missing Slack Channel ID for ${channelName}`;
      skippedChannels.push({ name: channelName, reason: "Missing Slack Channel ID" });
      continue;
    }
    try {
      channelMemberIds = await slack.getConversationMembers(slackChannelId);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      channelMembershipError = `Failed to get channel members for ${channelName} (${slackChannelId}): ${errMsg}`;
      console.error(`[RecurringIntros] ${channelMembershipError}`);
      skippedChannels.push({ name: channelName, reason: `Channel membership fetch failed: ${errMsg}` });
      continue;
    }

    const channelSlackUsers = channelMemberIds
      .map((id) => slackIdToUser.get(id))
      .filter((u): u is SlackUser => Boolean(u));

    const slackUserCount = channelSlackUsers.length;

    // Map channel members to Airtable members
    const eligibleMembers: RecurringMember[] = [];
    const excludedByReason: Record<string, RecurringMember[]> = {};
    const membersNotFoundInAirtable: string[] = [];
    const airtableMembersNotOnSlack: string[] = [];

    for (const slackUser of channelSlackUsers) {
      const email = normalizeEmail(slackUser.email);
      if (!email) {
        membersNotFoundInAirtable.push(`${slackUser.realName} (${slackUser.id}) — no email`);
        continue;
      }
      const memberRecord = emailToMemberRecord.get(email);
      if (!memberRecord) {
        membersNotFoundInAirtable.push(`${slackUser.realName} (${email})`);
        continue;
      }

      const mf = memberRecord.fields;
      const member: RecurringMember = {
        airtableRecordId: memberRecord.id,
        name: String(mf["Name"] || slackUser.realName),
        email,
        slackUserId: slackUser.id,
        city: String(mf["City"] || ""),
        recurringIntroStatus: String(mf["Recurring intro status"] || ""),
        recurringPauseUntil: mf["Recurring pause until"] ? String(mf["Recurring pause until"]) : null,
        payment: String(mf["Payment"] || ""),
        membership: String(mf["Membership"] || ""),
        serviceAccessUntil: mf["Service access until"] ? String(mf["Service access until"]) : null,
        firstIntroductionStatus: String(mf["First introduction status"] || ""),
      };

      if (isMemberEligible(member, cycleDate).eligible) {
        eligibleMembers.push(member);
      } else {
        const reason =
          member.payment !== "Paid" || member.membership !== "Active"
            ? "Inactive or unpaid"
            : member.recurringIntroStatus === "Excluded"
            ? "Excluded"
            : "Paused";
        if (!excludedByReason[reason]) excludedByReason[reason] = [];
        excludedByReason[reason].push(member);
      }
    }

    // Check Airtable members with email but not on Slack
    const channelEmails = new Set(channelSlackUsers.map((u) => normalizeEmail(u.email)));
    for (const mr of memberRecords) {
      const email = normalizeEmail(String(mr.fields["Slack Email"] || mr.fields["email"] || ""));
      if (!email) continue;
      const city = String(mr.fields["City"] || "");
      const payment = String(mr.fields["Payment"] || "");
      const membership = String(mr.fields["Membership"] || "");
      if (payment === "Paid" && membership === "Active" && !channelEmails.has(email)) {
        // Only flag if this member is supposedly in this city (best-effort check)
        if (city && channelName.toLowerCase().includes(city.toLowerCase())) {
          airtableMembersNotOnSlack.push(`${String(mr.fields["Name"] || "")} (${email})`);
        }
      }
    }

    // Fetch recent match groups for repeat prevention
    const recentPairs = new Map<string, Set<string>>();
    try {
      const thirtyDaysAgo = new Date(cycleDate);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const recentMatchRecords = await airtable.listRecords("MATCH GROUPS", {
        filterByFormula: `AND({Status} = "Done/Sent", IS_AFTER({Introduction date}, DATELIB("${thirtyDaysAgo.toISOString().slice(0, 10)}")))`,
        fields: ["Member 1", "Introduction date", "Status", "Source"],
      });
      const recordIdToEmail = new Map<string, string>();
      for (const mr of memberRecords) {
        const email = normalizeEmail(String(mr.fields["Slack Email"] || mr.fields["email"] || ""));
        if (email) recordIdToEmail.set(mr.id, email);
      }
      for (const rec of recentMatchRecords) {
        const member1Field = rec.fields["Member 1"];
        if (!Array.isArray(member1Field)) continue;
        const emails = member1Field
          .map((id: unknown) => recordIdToEmail.get(String(id)))
          .filter((e): e is string => Boolean(e));
        // Build pair set from linked record IDs
        for (let i = 0; i < emails.length; i++) {
          for (let j = i + 1; j < emails.length; j++) {
            const pairKey = [emails[i], emails[j]].sort().join("|");
            recentPairs.set(pairKey, new Set([emails[i], emails[j]]));
          }
        }
      }
    } catch {
      // Best-effort: proceed without repeat prevention
    }

    // Build groups
    const { groups, unmatched, warnings: repeatWarnings } = buildRecurringGroups(
      eligibleMembers,
      config.groupSize,
      config.strictGroupSize,
      cycleId,
      recentPairs
    );

    // Render messages
    const renderedMessages: string[] = [];
    for (const group of groups) {
      if (group.unmatched) continue;
      const participantMentions = group.members
        .map((m) => (m.slackUserId ? `<@${m.slackUserId}>` : m.name))
        .join(" ");
      const msg = renderRecurringMessage(
        config.introMessageTemplate,
        participantMentions,
        cityName,
        freqLabel,
        config.meetingDurationMinutes || null
      );
      renderedMessages.push(msg);
    }

    const preview: RecurringPreview = {
      channelName,
      cityName,
      cycleId,
      config,
      slackUserCount,
      eligibleMembers,
      proposedGroups: groups,
      groupSizes: groups.filter((g) => !g.unmatched).map((g) => g.members.length),
      unmatchedMembers: unmatched,
      excludedByReason,
      membersNotFoundInAirtable,
      airtableMembersNotOnSlack,
      recentRepeatWarnings: repeatWarnings,
      calendarWarning,
      renderedMessages,
      isDue,
      channelMembershipError,
    };

    previews.push(preview);

    // -----------------------------------------------------------------------
    // SEND MODE
    // -----------------------------------------------------------------------
    if (canDeliver && isDue) {
      if (!slackChannelId) {
        skippedChannels.push({ name: channelName, reason: "Missing Slack Channel ID" });
        continue;
      }
      if (allowedChannelIds && allowedChannelIds.size > 0 && !allowedChannelIds.has(slackChannelId)) {
        console.log(`[RecurringIntros] Skipping ${channelName} — channel not in allowlist`);
        skippedChannels.push({ name: channelName, reason: "Not in allowlist" });
        continue;
      }

      // Revalidate channel membership once per channel (not per member)
      let currentChannelMembers: string[] = [];
      try {
        currentChannelMembers = await slack.getConversationMembers(slackChannelId);
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        skippedChannels.push({ name: channelName, reason: `Channel membership revalidation failed: ${errMsg}` });
        continue;
      }

      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];
        if (group.unmatched) continue;
        const renderedMsg = renderedMessages[gi] || "";

        // Revalidate participants
        let valid = true;
        for (const member of group.members) {
          if (!isMemberEligible(member, cycleDate).eligible) {
            valid = false;
            break;
          }
          if (member.slackUserId && !currentChannelMembers.includes(member.slackUserId)) {
            valid = false;
            break;
          }
        }

        if (!valid) {
          failedGroups++;
          blockedGroups++;
          groupResults.push({
            groupId: `${cycleId}_${gi}`,
            channelName,
            cityName,
            memberNames: group.members.map(m => m.name),
            status: "blocked",
            slackConversationId: null,
            slackMessageTs: null,
            sendError: null,
            trackingError: "Revalidation failed — member became ineligible or left channel",
            alreadySent: false,
            simulated: false,
          });
          continue;
        }

        // Check idempotency
        let alreadySent = false;
        if (writesEnabled) {
          try {
            const existing = await airtable.listRecords("MATCH GROUPS", {
              filterByFormula: `AND({Cycle ID} = "${cycleId}", {Slack Channel} = "${channelRecord.id}")`,
              fields: ["Member 1", "Status"],
            });
            const participantIds = group.members.map((m) => m.airtableRecordId).sort();
            for (const ex of existing) {
              const exMembers = (Array.isArray(ex.fields["Member 1"]) ? ex.fields["Member 1"] : []).map(String).sort();
              if (JSON.stringify(exMembers) === JSON.stringify(participantIds)) {
                if (ex.fields["Status"] === "Done/Sent") {
                  alreadySent = true;
                  break;
                }
                // Failed — retry using existing record
                if (ex.fields["Status"] === "Failed") {
                  try {
                    const userIds = group.members
                      .map((m) => m.slackUserId)
                      .filter((id): id is string => Boolean(id));
                    const { channelId: convId } = await slack.conversationsOpen(userIds);
                    const { ts } = await slack.postMessage(convId, renderedMsg);
                    if (!ts) throw new Error("Slack postMessage returned no timestamp");
                    try {
                      await airtable.updateRecords("MATCH GROUPS", [{
                        id: ex.id,
                        fields: {
                          Status: "Done/Sent",
                          "Slack Conversation ID": convId,
                          "Slack Message Timestamp": ts,
                          "Send error": "",
                        },
                      }]);
                      sentGroups++;
                      groupResults.push({
                        groupId: `${cycleId}_${gi}`,
                        channelName,
                        cityName,
                        memberNames: group.members.map(m => m.name),
                        status: "sent",
                        slackConversationId: convId,
                        slackMessageTs: ts,
                        sendError: null,
                        trackingError: null,
                        alreadySent: false,
                        simulated: false,
                      });
                    } catch (trackErr) {
                      trackingFailedGroups++;
                      sentGroups++;
                      const tMsg = trackErr instanceof Error ? trackErr.message : String(trackErr);
                      groupResults.push({
                        groupId: `${cycleId}_${gi}`,
                        channelName,
                        cityName,
                        memberNames: group.members.map(m => m.name),
                        status: "tracking_failed",
                        slackConversationId: convId,
                        slackMessageTs: ts,
                        sendError: null,
                        trackingError: tMsg,
                        alreadySent: false,
                        simulated: false,
                      });
                    }
                  } catch (slackErr) {
                    const errMsg = slackErr instanceof Error ? slackErr.message : String(slackErr);
                    await airtable.updateRecords("MATCH GROUPS", [{
                      id: ex.id,
                      fields: { Status: "Failed", "Send error": errMsg },
                    }]);
                    failedGroups++;
                    groupResults.push({
                      groupId: `${cycleId}_${gi}`,
                      channelName,
                      cityName,
                      memberNames: group.members.map(m => m.name),
                      status: "failed",
                      slackConversationId: null,
                      slackMessageTs: null,
                      sendError: errMsg,
                      trackingError: null,
                      alreadySent: false,
                      simulated: false,
                    });
                  }
                  alreadySent = true;
                  break;
                }
              }
            }
          } catch {
            // Best-effort idempotency check — proceed with creation
          }
        }
        if (alreadySent) {
          alreadySentGroups++;
          groupResults.push({
            groupId: `${cycleId}_${gi}`,
            channelName,
            cityName,
            memberNames: group.members.map(m => m.name),
            status: "already_sent",
            slackConversationId: null,
            slackMessageTs: null,
            sendError: null,
            trackingError: null,
            alreadySent: true,
            simulated: false,
          });
          continue;
        }

        // Create Match-group record before Slack
        let matchGroupId = "";
        if (writesEnabled) {
          try {
            const [created] = await airtable.createRecords("MATCH GROUPS", [{
              fields: {
                Source: "Recurring",
                "Member 1": group.members.map((m) => m.airtableRecordId),
                "Introduction date": cycleDate.toISOString().slice(0, 10),
                Status: "Ready",
                "Cycle ID": cycleId,
                "Slack Channel": channelRecord.id,
              },
            }]);
            matchGroupId = created?.id || "";
          } catch {
            // If airtable write fails before Slack, still attempt delivery then mark tracking_failed
          }
        }

        // Send via Slack — real delivery only; require message timestamp
        try {
          const userIds = group.members
            .map((m) => m.slackUserId)
            .filter((id): id is string => Boolean(id));
          const { channelId: convId } = await slack.conversationsOpen(userIds);
          const { ts } = await slack.postMessage(convId, renderedMsg);
          if (!ts) throw new Error("Slack postMessage returned no timestamp");

          // Update Match-group record after confirmed Slack delivery
          if (writesEnabled && matchGroupId) {
            try {
              await airtable.updateRecords("MATCH GROUPS", [{
                id: matchGroupId,
                fields: {
                  Status: "Done/Sent",
                  "Slack Conversation ID": convId,
                  "Slack Message Timestamp": ts,
                },
              }]);
              sentGroups++;
              groupResults.push({
                groupId: `${cycleId}_${gi}`,
                channelName,
                cityName,
                memberNames: group.members.map(m => m.name),
                status: "sent",
                slackConversationId: convId,
                slackMessageTs: ts,
                sendError: null,
                trackingError: null,
                alreadySent: false,
                simulated: false,
              });
            } catch (trackErr) {
              trackingFailedGroups++;
              sentGroups++;
              const tMsg = trackErr instanceof Error ? trackErr.message : String(trackErr);
              groupResults.push({
                groupId: `${cycleId}_${gi}`,
                channelName,
                cityName,
                memberNames: group.members.map(m => m.name),
                status: "tracking_failed",
                slackConversationId: convId,
                slackMessageTs: ts,
                sendError: null,
                trackingError: tMsg,
                alreadySent: false,
                simulated: false,
              });
            }
          } else if (writesEnabled && !matchGroupId) {
            trackingFailedGroups++;
            sentGroups++;
            groupResults.push({
              groupId: `${cycleId}_${gi}`,
              channelName,
              cityName,
              memberNames: group.members.map(m => m.name),
              status: "tracking_failed",
              slackConversationId: convId,
              slackMessageTs: ts,
              sendError: null,
              trackingError: "Slack delivered but Match-group record was not created",
              alreadySent: false,
              simulated: false,
            });
          } else {
            sentGroups++;
            groupResults.push({
              groupId: `${cycleId}_${gi}`,
              channelName,
              cityName,
              memberNames: group.members.map(m => m.name),
              status: "sent",
              slackConversationId: convId,
              slackMessageTs: ts,
              sendError: null,
              trackingError: null,
              alreadySent: false,
              simulated: false,
            });
          }
        } catch (slackErr) {
          const errMsg = slackErr instanceof Error ? slackErr.message : String(slackErr);
          if (writesEnabled && matchGroupId) {
            try {
              await airtable.updateRecords("MATCH GROUPS", [{
                id: matchGroupId,
                fields: { Status: "Failed", "Send error": errMsg },
              }]);
            } catch {
              // ignore tracking failure on failed send
            }
          }
          failedGroups++;
          groupResults.push({
            groupId: `${cycleId}_${gi}`,
            channelName,
            cityName,
            memberNames: group.members.map(m => m.name),
            status: "failed",
            slackConversationId: null,
            slackMessageTs: null,
            sendError: errMsg,
            trackingError: null,
            alreadySent: false,
            simulated: false,
          });
        }
      }

      // Update Introduction data summary
      if (writesEnabled) {
        try {
          const successfulGroups = groups.filter((g) => !g.unmatched);
          const introduced = new Set<string>();
          let introsMade = 0;
          for (const group of successfulGroups) {
            if (!group.unmatched) {
              introsMade++;
              for (const m of group.members) introduced.add(m.airtableRecordId);
            }
          }
          const excludedCount = excludedByReason["Excluded"]?.length || 0;
          const inChannel = slackUserCount - excludedCount;

          // Upsert summary
          const existingSummaries = await airtable.listRecords("Introduction data", {
            filterByFormula: `AND({Cycle ID} = "${cycleId}", {Cities} = "${citiesRecordId}")`,
          });

          if (existingSummaries.length > 0) {
            await airtable.updateRecords("Introduction data", [{
              id: existingSummaries[0].id,
              fields: {
                "in channel": inChannel,
                "introduced": introduced.size,
                "excluded": inChannel - introduced.size,
                "intros made": introsMade,
              },
            }]);
          } else {
            await airtable.createRecords("Introduction data", [{
              fields: {
                Cities: citiesRecordId,
                "Intro date": cycleDate.toISOString().slice(0, 10),
                "in channel": inChannel,
                "introduced": introduced.size,
                "excluded": inChannel - introduced.size,
                "intros made": introsMade,
                "Cycle ID": cycleId,
              },
            }]);
          }

          // Advance Next introduction date only if all groups succeeded
          if (failedGroups === 0) {
            const nextDate = new Date(cycleDate);
            nextDate.setDate(nextDate.getDate() + config.introFrequencyWeeks * 7);
            await airtable.updateRecords("SLACK CHANNELS", [{
              id: channelRecord.id,
              fields: { "Next introduction date": nextDate.toISOString().slice(0, 10) },
            }]);
          }
        } catch (summaryErr) {
          console.error(`[RecurringIntros] Failed to update summary for ${channelName}:`, summaryErr);
        }
      }
    }
  }

  const summary = mode === "preview"
    ? `Previewed ${previews.length} channel(s), ${previews.reduce((n, p) => n + p.proposedGroups.filter((g) => !g.unmatched).length, 0)} groups`
    : `Processed ${previews.length} channel(s), ${sentGroups} sent, ${failedGroups} failed`;

  const success = failedGroups === 0;
  const partialSuccess = failedGroups > 0 && sentGroups > 0;
  return { success, partialSuccess, summary, previews, sentGroups, failedGroups, trackingFailedGroups, alreadySentGroups, simulatedGroups, blockedGroups, skippedChannels, groupResults };
}
