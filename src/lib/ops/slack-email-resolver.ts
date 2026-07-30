import type { AirtableRecord } from "../integrations/airtable";
import type { SlackUser } from "../integrations/slack";

export interface EmailSuggestion {
  airtableRecordId: string;
  name: string;
  airtableEmail: string;
  suggestedSlackEmail: string;
  suggestedSlackName: string;
  slackUserId: string;
  confidence: "high" | "low";
  city: string;
}

export interface SkippedMember {
  airtableRecordId: string;
  name: string;
  airtableEmail: string;
  city: string;
  reason: "already_matched" | "has_slack_email" | "no_email" | "no_name" | "unmatched";
  detail: string;
}

export interface ResolveResult {
  suggestions: EmailSuggestion[];
  skipped: SkippedMember[];
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitWords(name: string): Set<string> {
  return new Set(
    normalizeName(name)
      .split(/\s+/)
      .filter((w) => w.length > 1)
  );
}

function findSimilarNames(memberName: string, nameToSlackUsers: Map<string, SlackUser[]>): string[] {
  const memberWords = splitWords(memberName);
  if (memberWords.size === 0) return [];

  const scored: Array<{ name: string; score: number }> = [];
  for (const [normName, users] of nameToSlackUsers) {
    const userWords = splitWords(normName);
    let overlap = 0;
    for (const w of memberWords) {
      if (userWords.has(w)) overlap++;
    }
    if (overlap > 0) {
      const displayName = users[0].realName || users[0].name;
      scored.push({ name: displayName, score: overlap });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((s) => `"${s.name}"`);
}

export function resolveSlackEmails(
  memberRecords: AirtableRecord[],
  slackUsers: SlackUser[]
): ResolveResult {
  const suggestions: EmailSuggestion[] = [];
  const skipped: SkippedMember[] = [];

  // Filter Slack users: no bots, no deleted, must have email
  const activeSlackUsers = slackUsers.filter(
    (u) => !u.deleted && !u.isBot && !u.isAppUser
  );

  // Map: normalized email → Slack user
  const emailToSlackUser = new Map<string, SlackUser>();
  for (const u of activeSlackUsers) {
    const email = normalizeEmail(u.email);
    if (email) emailToSlackUser.set(email, u);
  }

  // Map: normalized name → Slack users (can be multiple)
  const nameToSlackUsers = new Map<string, SlackUser[]>();
  for (const u of activeSlackUsers) {
    const normName = normalizeName(u.realName || u.name || "");
    if (!normName) continue;
    const existing = nameToSlackUsers.get(normName) || [];
    existing.push(u);
    nameToSlackUsers.set(normName, existing);
  }

  for (const mr of memberRecords) {
    const memberName = String(mr.fields["Name"] || "").trim();
    const memberEmail = normalizeEmail(String(mr.fields["email"] || ""));
    const slackEmail = normalizeEmail(String(mr.fields["Slack Email"] || ""));
    const memberCity = String(mr.fields["City"] || "").trim();

    // Already has Slack Email → skip
    if (slackEmail) {
      skipped.push({
        airtableRecordId: mr.id,
        name: memberName,
        airtableEmail: memberEmail,
        city: memberCity,
        reason: "has_slack_email",
        detail: `Slack Email field is already set to "${slackEmail}"`,
      });
      continue;
    }

    // Main email already matches a Slack user → no issue, skip
    if (memberEmail && emailToSlackUser.has(memberEmail)) {
      const matched = emailToSlackUser.get(memberEmail)!;
      skipped.push({
        airtableRecordId: mr.id,
        name: memberName,
        airtableEmail: memberEmail,
        city: memberCity,
        reason: "already_matched",
        detail: `Airtable email "${memberEmail}" matches Slack user "${matched.realName || matched.name}" (${matched.id})`,
      });
      continue;
    }

    // No email in Airtable → can't match
    if (!memberEmail) {
      skipped.push({
        airtableRecordId: mr.id,
        name: memberName,
        airtableEmail: "",
        city: memberCity,
        reason: "no_email",
        detail: `No email field in Airtable for "${memberName}"`,
      });
      continue;
    }

    // Try name-based matching
    const normName = normalizeName(memberName);
    if (!normName) {
      skipped.push({
        airtableRecordId: mr.id,
        name: memberName,
        airtableEmail: memberEmail,
        city: memberCity,
        reason: "no_name",
        detail: `Name "${memberName}" normalizes to empty string`,
      });
      continue;
    }

    const exactMatches = nameToSlackUsers.get(normName);

    if (exactMatches && exactMatches.length > 0) {
      if (exactMatches.length === 1) {
        // Exact name match, single Slack user → High confidence
        suggestions.push({
          airtableRecordId: mr.id,
          name: memberName,
          airtableEmail: memberEmail,
          suggestedSlackEmail: normalizeEmail(exactMatches[0].email),
          suggestedSlackName: exactMatches[0].realName || exactMatches[0].name,
          slackUserId: exactMatches[0].id,
          confidence: "high",
          city: memberCity,
        });
        continue;
      } else {
        // Exact name match, multiple Slack users → Low confidence
        for (const su of exactMatches) {
          suggestions.push({
            airtableRecordId: mr.id,
            name: memberName,
            airtableEmail: memberEmail,
            suggestedSlackEmail: normalizeEmail(su.email),
            suggestedSlackName: su.realName || su.name,
            slackUserId: su.id,
            confidence: "low",
            city: memberCity,
          });
        }
        continue;
      }
    }

    // No exact name match → unmatched
    skipped.push({
      airtableRecordId: mr.id,
      name: memberName,
      airtableEmail: memberEmail,
      city: memberCity,
      reason: "unmatched",
      detail: (() => {
        const similar = findSimilarNames(memberName, nameToSlackUsers);
        const base = `No Slack user found with a matching name for "${memberName}" (${activeSlackUsers.length} Slack users checked)`;
        if (similar.length > 0) return `${base}. Similar names found: ${similar.join(", ")}`;
        return base;
      })(),
    });
  }

  // Sort: high → low
  const order = { high: 0, low: 1 };
  suggestions.sort((a, b) => order[a.confidence] - order[b.confidence]);

  // Sort skipped: by reason then by name
  const reasonOrder: Record<string, number> = {
    already_matched: 0,
    has_slack_email: 1,
    unmatched: 2,
    no_email: 3,
    no_name: 4,
  };
  skipped.sort((a, b) => reasonOrder[a.reason] - reasonOrder[b.reason] || a.name.localeCompare(b.name));

  return { suggestions, skipped };
}
