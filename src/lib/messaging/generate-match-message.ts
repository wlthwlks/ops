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
 * Find up to 2 reasons why these members are a good match.
 */
function findReasons(
  newMember: MessageMember,
  matches: MessageMember[],
  meetingSpots: string[]
): string[] {
  const reasons: string[] = [];

  const memberStage = String(newMember.businessStage || "");
  if (memberStage && matches.some((m) => String(m.businessStage || "") === memberStage)) {
    reasons.push(`you're at a similar business stage (${memberStage})`);
  }

  const memberInd = String(newMember.industry || "").toLowerCase();
  if (memberInd && matches.some((m) => String(m.industry || "").toLowerCase() === memberInd)) {
    reasons.push(`you share the same industry (${newMember.industry})`);
  }

  if (reasons.length < 2 && meetingSpots.length > 0) {
    reasons.push("you're based in the same area");
  }

  return reasons.slice(0, 2);
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
}): GeneratedMessage {
  const { newMember, matches, format, slackUserIds } = input;

  const allMembers = [newMember, ...matches];
  const memberFirstName = String(newMember.name).split(" ")[0];
  const matchFirstNames = matches.map((m) => String(m.name).split(" ")[0]);
  const recipients = allMembers.map((m) => String(m.email));

  const meetingSpots = findMeetingSpots(allMembers);
  const reasons = findReasons(newMember, matches, meetingSpots);
  const nameList = formatNameList(matchFirstNames);

  if (format === "slack") {
    return buildSlackMessage({
      memberFirstName,
      matches,
      nameList,
      reasons,
      meetingSpots,
      recipients,
      slackUserIds: slackUserIds ?? new Map(),
    });
  }

  return buildPlaintextMessage({
    memberFirstName,
    nameList,
    reasons,
    meetingSpots,
    recipients,
  });
}

function buildPlaintextMessage(p: {
  memberFirstName: string;
  nameList: string;
  reasons: string[];
  meetingSpots: string[];
  recipients: string[];
}): GeneratedMessage {
  const lines: string[] = [];
  lines.push(`Dear ${p.memberFirstName},`);
  lines.push("");
  lines.push("Welcome to the community! We've found some great connections for you.");
  lines.push("");
  lines.push(
    `We'd love to introduce you to ${p.nameList} — we noticed some exciting similarities between you${
      p.reasons.length > 0 ? ": " + p.reasons.join(", and ") : ""
    }.`
  );
  lines.push("");
  if (p.meetingSpots.length > 0) {
    lines.push(`Here are a few suggested meeting spots near you: ${p.meetingSpots.join(", ")}.`);
    lines.push("");
  }
  lines.push("Looking forward to seeing you connect!");
  lines.push("");
  lines.push("Best,");
  lines.push("The WLTH WLKS Team");

  return { body: lines.join("\n"), recipients: p.recipients };
}

function buildSlackMessage(p: {
  memberFirstName: string;
  matches: MessageMember[];
  nameList: string;
  reasons: string[];
  meetingSpots: string[];
  recipients: string[];
  slackUserIds: Map<string, string>;
}): GeneratedMessage {
  // Build a display name for each match, using @mention if they're on Slack
  const matchDisplayNames = p.matches.map((m) => {
    const slackId = p.slackUserIds.get(m.email);
    const firstName = String(m.name).split(" ")[0];
    return slackId ? `<@${slackId}>` : `*${firstName}*`;
  });
  const slackNameList = formatNameList(matchDisplayNames);

  const lines: string[] = [];
  lines.push(`Hi ${p.memberFirstName}! :wave:`);
  lines.push("");
  lines.push("Welcome to the community! We've found some great connections for you.");
  lines.push("");
  lines.push(
    `We'd love to introduce you to ${slackNameList} — we noticed some exciting similarities between you${
      p.reasons.length > 0 ? ": " + p.reasons.join(", and ") : ""
    }.`
  );
  lines.push("");
  if (p.meetingSpots.length > 0) {
    lines.push(`:round_pushpin: Suggested meeting spots near you: ${p.meetingSpots.join(", ")}.`);
    lines.push("");
  }
  lines.push(":email: You'll also receive an email with everyone's contact details.");
  lines.push("");
  lines.push("Looking forward to seeing you connect! :handshake:");

  return { body: lines.join("\n"), recipients: p.recipients };
}
