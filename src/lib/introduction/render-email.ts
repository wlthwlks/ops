import type { ScoreComponent } from "./profiles";
import {
  extractPlaceholders,
  KNOWN_PLACEHOLDERS,
} from "./templates";

/**
 * Server-side rendering of introduction group emails. Admin templates only
 * control layout via controlled placeholders; the repeated member sections
 * and match explanations are generated here, safely escaped, so admins
 * never write loops or risk unescaped member content.
 */

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "Sarah, Priya and James" style joining. */
export function joinNames(names: string[]): string {
  const cleaned = names.map((n) => n.trim()).filter(Boolean);
  if (cleaned.length === 0) return "";
  if (cleaned.length === 1) return cleaned[0];
  if (cleaned.length === 2) return `${cleaned[0]} and ${cleaned[1]}`;
  return `${cleaned.slice(0, -1).join(", ")} and ${cleaned[cleaned.length - 1]}`;
}

/** Deterministic long-form date for "YYYY-MM-DD" input, e.g. "16 August 2026". */
export function formatIntroductionDate(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateStr;
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${date.getUTCDate()} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** "FUNDRAISING" → "Fundraising" for display. */
export function prettifyCode(code: string): string {
  const words = code.replace(/[_-]+/g, " ").trim().toLowerCase().split(/\s+/);
  return words.map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

export interface MemberCardData {
  key: string;
  firstName: string | null;
  fullName: string | null;
  professionalHeadline: string | null;
  city: string | null;
  industry: string | null;
  businessStage: string | null;
  helpWanted: string[];
  expertise: string[];
}

export function renderMemberCard(member: MemberCardData): string {
  const displayName = member.fullName || member.firstName || member.key;
  const lines: string[] = [];
  const title = member.professionalHeadline
    ? `${esc(displayName)} — ${esc(member.professionalHeadline)}`
    : esc(displayName);
  lines.push(`<p style="margin: 12px 0 4px 0;"><strong>${title}</strong></p>`);

  const meta: string[] = [];
  if (member.city) meta.push(esc(member.city));
  if (member.industry) meta.push(esc(prettifyCode(member.industry)));
  if (member.businessStage) meta.push(esc(prettifyCode(member.businessStage)));
  if (meta.length > 0) {
    lines.push(`<p style="margin: 0 0 4px 0; color: #555;">${meta.join(" · ")}</p>`);
  }
  if (member.helpWanted.length > 0) {
    lines.push(
      `<p style="margin: 0 0 4px 0;"><strong>Seeking help with:</strong> ${esc(
        member.helpWanted.map(prettifyCode).join(", ")
      )}</p>`
    );
  }
  if (member.expertise.length > 0) {
    lines.push(
      `<p style="margin: 0 0 4px 0;"><strong>Can help with:</strong> ${esc(
        member.expertise.map(prettifyCode).join(", ")
      )}</p>`
    );
  }
  return lines.join("\n");
}

export const COMPONENT_PHRASES: Record<ScoreComponent, string> = {
  proximity: "You live close to each other",
  ai_correlation: "Your profiles have a lot in common",
  help_expertise: "Your needs and expertise complement each other",
  goal_relevance: "You share similar 90-day goals",
  connection_type: "Your connection preferences align",
  industry: "You work in the same industry",
  business_stage: "You are at a similar business stage",
};

export function renderWhyMatched(
  breakdown: Partial<Record<ScoreComponent, number>> | null | undefined
): string {
  const entries = Object.entries(breakdown ?? {}) as Array<[ScoreComponent, number]>;
  const strong = entries
    .filter(([, score]) => (score ?? 0) >= 0.6)
    .sort((a, b) => b[1] - a[1]);
  const chosen = strong.length >= 3 ? strong.slice(0, 3) : strong.slice(0, 4);
  if (chosen.length === 0) {
    return `<p><strong>Why you matched</strong></p><p>You were grouped together as part of this month's ${esc("WLTH WLKS")} city introductions.</p>`;
  }
  const bullets = chosen
    .map(
      ([component, score]) =>
        `<li>${esc(COMPONENT_PHRASES[component])} (${Math.round((score ?? 0) * 100)}%)</li>`
    )
    .join("\n");
  return `<p><strong>Why you matched</strong></p><ul>${bullets}</ul>`;
}

export function renderCoordinationText(): string {
  return (
    "To arrange your walk, simply hit reply-all on this email — everyone in your group " +
    "is included. Please do not reply to the sender address; it is not monitored."
  );
}

export interface RenderIntroductionEmailInput {
  subject: string;
  bodyHtml: string;
  cityName: string;
  introductionDate: string;
  members: MemberCardData[];
  groupScoreBreakdown?: Partial<Record<ScoreComponent, number>> | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

export function renderIntroductionEmail(input: RenderIntroductionEmailInput): RenderedEmail {
  const firstNames = input.members
    .map((m) => m.firstName ?? (m.fullName ? m.fullName.split(" ")[0] : ""))
    .filter(Boolean) as string[];

  const membersBlock = input.members.map(renderMemberCard).join("\n");
  const whyBlock = renderWhyMatched(input.groupScoreBreakdown);
  const coordination = renderCoordinationText();

  const replacements: Record<string, string> = {
    "{{first_name}}": esc(joinNames(firstNames)),
    "{{city}}": esc(input.cityName),
    "{{introduction_date}}": esc(formatIntroductionDate(input.introductionDate)),
    "{{members}}": membersBlock,
    "{{why_you_matched}}": whyBlock,
    "{{coordination_text}}": esc(coordination),
  };

  const replace = (template: string) => {
    let result = template;
    for (const [token, value] of Object.entries(replacements)) {
      const pattern = new RegExp(token.replace(/[{}]/g, "\\$&"), "gi");
      result = result.replace(pattern, value);
    }
    return result;
  };

  return {
    subject: replace(input.subject),
    html: replace(input.bodyHtml),
  };
}

/** Unknown placeholder tokens that would survive rendering. */
export function unknownPlaceholders(subject: string, bodyHtml: string): string[] {
  const known = new Set<string>(KNOWN_PLACEHOLDERS);
  return [...extractPlaceholders(subject), ...extractPlaceholders(bodyHtml)].filter(
    (token) => !known.has(token)
  );
}

/** Sample member cards used for template previews and test sends. */
export const SAMPLE_MEMBER_CARDS: MemberCardData[] = [
  {
    key: "sample-1",
    firstName: "Sarah",
    fullName: "Sarah Smith",
    professionalHeadline: "Founder of a wellness app",
    city: "London",
    industry: "TECH_SAAS",
    businessStage: "EARLY_TRACTION",
    helpWanted: ["FUNDRAISING"],
    expertise: ["GROWTH_MARKETING"],
  },
  {
    key: "sample-2",
    firstName: "Priya",
    fullName: "Priya Patel",
    professionalHeadline: "Ex-investment banker",
    city: "London",
    industry: "FINANCE",
    businessStage: "SCALING",
    helpWanted: ["HIRING"],
    expertise: ["FUNDRAISING", "FINANCE"],
  },
  {
    key: "sample-3",
    firstName: "James",
    fullName: "James Okafor",
    professionalHeadline: "Product designer",
    city: "London",
    industry: "CREATIVE_MEDIA",
    businessStage: "VALIDATING",
    helpWanted: ["SALES"],
    expertise: ["PRODUCT"],
  },
];

export function renderSampleEmail(subject: string, bodyHtml: string): RenderedEmail {
  return renderIntroductionEmail({
    subject,
    bodyHtml,
    cityName: "London",
    introductionDate: new Date().toISOString().slice(0, 10),
    members: SAMPLE_MEMBER_CARDS,
    groupScoreBreakdown: {
      proximity: 0.94,
      ai_correlation: 0.81,
      help_expertise: 0.96,
      goal_relevance: 0.89,
      industry: 0.7,
      business_stage: 0.8,
    },
  });
}
