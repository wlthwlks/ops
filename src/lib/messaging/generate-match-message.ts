import type { MessageMember, MessageFormat, GeneratedMessage } from "./types";

/**
 * Compute locations shared by 2+ members, sorted by frequency, top 3.
 */
function findMeetingSpots(members: MessageMember[]): string[] {
  const locCounts = new Map<string, number>();
  for (const m of members) {
    const locs = String(m.nearbyLocation || "")
      .split(/\s*[|,]\s*/)
      .map((l) => l.trim())
      .filter((l) => l.length > 1);
    for (const loc of new Set(locs)) {
      locCounts.set(loc, (locCounts.get(loc) ?? 0) + 1);
    }
  }
  return Array.from(locCounts.entries())
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([loc]) => loc);
}


/**
 * Build a natural sentence describing all matches together.
 */
function buildGroupDescription(
  matches: MessageMember[],
  newMember: MessageMember,
  format: "plaintext" | "slack",
  slackUserIds?: Map<string, string>
): string {
  const getName = (m: MessageMember) => {
    const first = String(m.name).split(" ")[0];
    if (format === "slack") {
      const slackId = slackUserIds?.get(m.email);
      return slackId ? `<@${slackId}>` : `*${first}*`;
    }
    return first;
  };

  // Collect unique industries and stages across all matches
  const industries = new Set(matches.map((m) => m.industry).filter(Boolean));
  const stages = new Set(matches.map((m) => m.businessStage).filter(Boolean));

  // Build per-member snippets: "Alice (Coach)" or "Bob (SaaS, Early Scale)"
  const snippets = matches.map((m) => {
    const name = getName(m);
    const bits: string[] = [];
    if (m.industry) bits.push(m.industry);
    if (m.businessStage) bits.push(m.businessStage);
    return bits.length > 0 ? `${name} (${bits.join(", ")})` : name;
  });

  const list = formatNameList(snippets);

  // Build a connecting sentence about what they share
  const shared: string[] = [];
  if (newMember.industry && industries.has(newMember.industry)) {
    shared.push(`working in ${newMember.industry}`);
  }
  if (newMember.businessStage && stages.has(newMember.businessStage)) {
    shared.push(`at a similar revenue stage`);
  }

  if (shared.length > 0) {
    return `${list}. You have a lot in common — ${shared.join(" and ")}, so there's plenty to talk about.`;
  }
  return `${list}. Each of you brings a different perspective, which makes for great conversations.`;
}

interface CoordEntry {
  first: string;
  text: string;
}

const memberFirst = (m: MessageMember) => String(m.name).split(" ")[0];

/** Members (new + matches) who supplied free-text availability. */
function availabilityEntries(members: MessageMember[]): CoordEntry[] {
  return members
    .map((m) => ({ first: memberFirst(m), text: (m.availability ?? "").trim() }))
    .filter((e) => e.text.length > 0);
}

/** Members (new + matches) who supplied free-text topics to discuss. */
function topicEntries(members: MessageMember[]): CoordEntry[] {
  return members
    .map((m) => ({ first: memberFirst(m), text: (m.topics ?? "").trim() }))
    .filter((e) => e.text.length > 0);
}

/**
 * Format a list of names: "Alice", "Alice and Bob", "Alice, Bob and Carol"
 */
function formatNameList(names: string[]): string {
  if (names.length === 1) return names[0];
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
}

/**
 * Generate an introduction message for a new member and their matches.
 *
 * @param format - "plaintext" for clipboard/draft, "slack" for Slack group DM
 * @param slackUserIds - email→Slack user ID map (for @mentions in slack format)
 */
export function generateMatchMessage(input: {
  newMember: MessageMember;
  matches: MessageMember[];
  format: MessageFormat;
  slackUserIds?: Map<string, string>;
  slackInviteUrl?: string;
  isOnSlack?: boolean;
}): GeneratedMessage {
  const { newMember, matches, format, slackUserIds, slackInviteUrl, isOnSlack } = input;

  const allMembers = [newMember, ...matches];
  const memberFirstName = String(newMember.name).split(" ")[0];
  const recipients = allMembers.map((m) => String(m.email));
  const meetingSpots = findMeetingSpots(allMembers);

  if (format === "slack") {
    return buildSlackMessage({
      memberFirstName,
      newMember,
      matches,
      meetingSpots,
      recipients,
      slackUserIds: slackUserIds ?? new Map(),
    });
  }

  if (format === "html") {
    return buildHtmlMessage({
      memberFirstName,
      newMember,
      matches,
      meetingSpots,
      recipients,
      slackInviteUrl,
      isOnSlack,
    });
  }

  return buildPlaintextMessage({
    memberFirstName,
    newMember,
    matches,
    meetingSpots,
    recipients,
  });
}

function buildPlaintextMessage(p: {
  memberFirstName: string;
  newMember: MessageMember;
  matches: MessageMember[];
  meetingSpots: string[];
  recipients: string[];
}): GeneratedMessage {
  const groupDesc = buildGroupDescription(p.matches, p.newMember, "plaintext");

  const lines: string[] = [];
  lines.push(`Hi ${p.memberFirstName},`);
  lines.push("");
  lines.push("Welcome to WLTH WLKS! We've matched you with a few members we think you'll really get along with.");
  lines.push("");
  lines.push(`We'd like to introduce you to ${groupDesc}`);
  lines.push("");
  if (p.meetingSpots.length > 0) {
    lines.push(`You're all based around ${p.meetingSpots.join(", ")} — great spots to grab a coffee and connect.`);
    lines.push("");
  }
  const availP = availabilityEntries([p.newMember, ...p.matches]);
  if (availP.length > 0) {
    lines.push("Here's when people are free to meet — find a slot that works for everyone:");
    for (const e of availP) lines.push(`- ${e.first}: ${e.text}`);
    lines.push("");
  }
  const topicsP = topicEntries([p.newMember, ...p.matches]);
  if (topicsP.length > 0) {
    lines.push("Topics they'd like to discuss:");
    for (const e of topicsP) lines.push(`- ${e.first}: ${e.text}`);
    lines.push("");
  }
  lines.push("We'd love for you to meet up and share what you're working on. Sometimes the best ideas come from a conversation with someone on a similar journey.");
  lines.push("");
  lines.push("Looking forward to seeing you connect!");
  lines.push("");
  lines.push("Best,");
  lines.push("The WLTH WLKS Team");

  return { body: lines.join("\n"), recipients: p.recipients };
}

function buildSlackMessage(p: {
  memberFirstName: string;
  newMember: MessageMember;
  matches: MessageMember[];
  meetingSpots: string[];
  recipients: string[];
  slackUserIds: Map<string, string>;
}): GeneratedMessage {
  const groupDesc = buildGroupDescription(p.matches, p.newMember, "slack", p.slackUserIds);

  const lines: string[] = [];
  lines.push(`Hi ${p.memberFirstName}! :wave:`);
  lines.push("");
  lines.push("Welcome to WLTH WLKS! We've matched you with a few members we think you'll really get along with.");
  lines.push("");
  lines.push(`We'd like to introduce you to ${groupDesc}`);
  lines.push("");
  if (p.meetingSpots.length > 0) {
    lines.push(`:round_pushpin: You're all based around ${p.meetingSpots.join(", ")} — great spots to grab a coffee and connect.`);
    lines.push("");
  }
  const availS = availabilityEntries([p.newMember, ...p.matches]);
  if (availS.length > 0) {
    lines.push(":calendar: Here's when people are free to meet — find a slot that works for everyone:");
    for (const e of availS) lines.push(`• *${e.first}*: ${e.text}`);
    lines.push("");
  }
  const topicsS = topicEntries([p.newMember, ...p.matches]);
  if (topicsS.length > 0) {
    lines.push(":speech_balloon: Topics they'd like to discuss:");
    for (const e of topicsS) lines.push(`• *${e.first}*: ${e.text}`);
    lines.push("");
  }
  lines.push("We'd love for you to meet up and share what you're working on. Sometimes the best ideas come from a conversation with someone on a similar journey. :handshake:");
  lines.push("");
  // Kick-off CTA addressed to the new joiner — references the suggested spots
  // when we surfaced them, otherwise nudges them to propose a time + place.
  const newMemberSlackId = p.slackUserIds.get(p.newMember.email);
  const newMemberMention = newMemberSlackId ? `<@${newMemberSlackId}>` : `*${p.memberFirstName}*`;
  if (p.meetingSpots.length > 0) {
    lines.push(`:calendar: ${newMemberMention}, fancy kicking things off? Drop a couple of times that work for you and pick one of the spots above — the rest can chime in. :sparkles:`);
  } else {
    lines.push(`:calendar: ${newMemberMention}, fancy kicking things off? Drop a couple of times that work for you and suggest a spot — the rest can chime in. :sparkles:`);
  }
  lines.push("");
  lines.push(":email: You'll also receive an email with everyone's contact details.");

  return { body: lines.join("\n"), recipients: p.recipients };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const EMAIL_TEMPLATE = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; color: #333; line-height: 1.6;">
  <p>Hi {{FIRST_NAME}},</p>

  <p>Welcome to WLTH WLKS! We've matched you with a few members we think you'll really get along with.</p>

  <p>We'd like to introduce you to {{GROUP_DESCRIPTION}}</p>

  {{MEETING_SPOTS}}

  {{COORDINATION}}

  <p>We'd love for you to meet up and share what you're working on. Sometimes the best ideas come from a conversation with someone on a similar journey.</p>

  {{SLACK_SECTION}}

  <p>Looking forward to seeing you connect!</p>

  {{KICKOFF_INVITE}}

  <p>Best,<br/>The WLTH WLKS Team</p>
</div>`.trim();

function buildHtmlMessage(p: {
  memberFirstName: string;
  newMember: MessageMember;
  matches: MessageMember[];
  meetingSpots: string[];
  recipients: string[];
  slackInviteUrl?: string;
  isOnSlack?: boolean;
}): GeneratedMessage {
  const groupDesc = buildGroupDescription(p.matches, p.newMember, "plaintext");

  const meetingSpots = p.meetingSpots.length > 0
    ? `<p>You're all based around ${esc(p.meetingSpots.join(", "))} — great spots to grab a coffee and connect.</p>`
    : "";

  const slackSection = p.isOnSlack
    ? `<p>We've also added you to a Slack group message so you can all start chatting right away.</p>`
    : p.slackInviteUrl
    ? `<p>Some of your matches are already on our Slack community. <a href="${esc(p.slackInviteUrl)}" style="color: #1890ff; text-decoration: underline; font-weight: 600;">Join the WLTH WLKS Slack</a> to connect with them directly.</p>`
    : "";

  // Coordination block — availability + topics, only when someone supplied them.
  const allForCoord = [p.newMember, ...p.matches];
  const availH = availabilityEntries(allForCoord);
  const topicsH = topicEntries(allForCoord);
  const coordParts: string[] = [];
  if (availH.length > 0) {
    const items = availH.map((e) => `<li><strong>${esc(e.first)}</strong>: ${esc(e.text)}</li>`).join("");
    coordParts.push(`<p style="margin-bottom: 4px;">Here's when people are free to meet — find a slot that works for everyone:</p><ul style="padding-left: 20px; margin-top: 0;">${items}</ul>`);
  }
  if (topicsH.length > 0) {
    const items = topicsH.map((e) => `<li><strong>${esc(e.first)}</strong>: ${esc(e.text)}</li>`).join("");
    coordParts.push(`<p style="margin-bottom: 4px;">Topics they'd like to discuss:</p><ul style="padding-left: 20px; margin-top: 0;">${items}</ul>`);
  }
  const coordination = coordParts.join("\n");

  // Kick-off CTA addressed to the new joiner — references the suggested spots
  // when we surfaced them, otherwise just nudges them to propose times.
  const kickoffInvite = p.meetingSpots.length > 0
    ? `<p>${esc(p.memberFirstName)}, would you like to kick things off? A quick reply-all with a couple of times that work for you and which of the spots above suits — and the group can confirm from there.</p>`
    : `<p>${esc(p.memberFirstName)}, would you like to kick things off? A quick reply-all with a couple of times and a location idea, and the group can take it from there.</p>`;

  const html = EMAIL_TEMPLATE
    .replace("{{FIRST_NAME}}", esc(p.memberFirstName))
    .replace("{{GROUP_DESCRIPTION}}", esc(groupDesc))
    .replace("{{MEETING_SPOTS}}", meetingSpots)
    .replace("{{COORDINATION}}", coordination)
    .replace("{{SLACK_SECTION}}", slackSection)
    .replace("{{KICKOFF_INVITE}}", kickoffInvite);

  return { body: html, recipients: p.recipients };
}
