import { describe, it, expect } from "vitest";
import {
  COMPONENT_PHRASES,
  esc,
  formatIntroductionDate,
  joinNames,
  prettifyCode,
  renderCoordinationText,
  renderIntroductionEmail,
  renderMemberCard,
  renderWhyMatched,
  unknownPlaceholders,
  type MemberCardData,
} from "@/lib/introduction/render-email";
import {
  DEFAULT_TEMPLATE_BODY,
  DEFAULT_TEMPLATE_SUBJECT,
  validateTemplateContent,
} from "@/lib/introduction/templates";

const members: MemberCardData[] = [
  {
    key: "at:rec_a",
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
    key: "at:rec_b",
    firstName: "Priya",
    fullName: "Priya Patel",
    professionalHeadline: null,
    city: "London",
    industry: "FINANCE",
    businessStage: "SCALING",
    helpWanted: [],
    expertise: ["FUNDRAISING"],
  },
];

describe("esc", () => {
  it("escapes HTML characters", () => {
    expect(esc(`<script>"'&`)).toBe("&lt;script&gt;&quot;&#39;&amp;");
  });
});

describe("joinNames", () => {
  it("joins one, two and many names", () => {
    expect(joinNames(["Sarah"])).toBe("Sarah");
    expect(joinNames(["Sarah", "Priya"])).toBe("Sarah and Priya");
    expect(joinNames(["Sarah", "Priya", "James"])).toBe("Sarah, Priya and James");
    expect(joinNames([])).toBe("");
  });
});

describe("formatIntroductionDate", () => {
  it("formats ISO dates deterministically", () => {
    expect(formatIntroductionDate("2026-08-16")).toBe("16 August 2026");
    expect(formatIntroductionDate("2026-01-02")).toBe("2 January 2026");
    expect(formatIntroductionDate("not-a-date")).toBe("not-a-date");
  });
});

describe("prettifyCode", () => {
  it("converts codes to readable labels", () => {
    expect(prettifyCode("GROWTH_MARKETING")).toBe("Growth Marketing");
    expect(prettifyCode("I_CAN_MENTOR")).toBe("I Can Mentor");
  });
});

describe("renderMemberCard", () => {
  it("includes name, headline, meta and help/expertise", () => {
    const html = renderMemberCard(members[0]);
    expect(html).toContain("Sarah Smith");
    expect(html).toContain("Founder of a wellness app");
    expect(html).toContain("Tech Saas");
    expect(html).toContain("Seeking help with:");
    expect(html).toContain("Fundraising");
    expect(html).toContain("Can help with:");
  });

  it("escapes member-provided content", () => {
    const html = renderMemberCard({
      key: "at:rec_x",
      firstName: null,
      fullName: '<img src=x onerror=alert(1)>',
      professionalHeadline: null,
      city: null,
      industry: null,
      businessStage: null,
      helpWanted: [],
      expertise: [],
    });
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
  });
});

describe("renderWhyMatched", () => {
  it("lists strong components with percentages", () => {
    const html = renderWhyMatched({
      proximity: 0.94,
      ai_correlation: 0.81,
      help_expertise: 0.96,
      industry: 0.7,
      business_stage: 0.2,
    });
    expect(html).toContain(COMPONENT_PHRASES.proximity);
    expect(html).toContain("(94%)");
    expect(html).toContain(COMPONENT_PHRASES.help_expertise);
    expect(html).toContain(COMPONENT_PHRASES.ai_correlation);
    expect(html).not.toContain(COMPONENT_PHRASES.business_stage);
  });

  it("produces a fallback when nothing scores strongly", () => {
    const html = renderWhyMatched({ proximity: 0.1 });
    expect(html).toContain("Why you matched");
    expect(html).toContain("WLTH WLKS");
  });
});

describe("renderIntroductionEmail", () => {
  it("replaces every controlled placeholder", () => {
    const rendered = renderIntroductionEmail({
      subject: DEFAULT_TEMPLATE_SUBJECT,
      bodyHtml: DEFAULT_TEMPLATE_BODY,
      cityName: "London",
      introductionDate: "2026-08-16",
      members,
      groupScoreBreakdown: { proximity: 0.94, help_expertise: 0.96 },
    });

    expect(rendered.subject).toBe("Meet your London introductions");
    expect(rendered.html).toContain("Sarah and Priya");
    expect(rendered.html).toContain("16 August 2026");
    expect(rendered.html).toContain("Sarah Smith");
    expect(rendered.html).toContain("Priya Patel");
    expect(rendered.html).toContain("reply-all");
    expect(rendered.html).not.toContain("{{members}}");
    expect(rendered.html).not.toContain("{{coordination_text}}");
    expect(rendered.html).not.toContain("{{first_name}}");
  });

  it("leaves unknown placeholders untouched", () => {
    const rendered = renderIntroductionEmail({
      subject: "Hello {{first_name}}",
      bodyHtml: "<p>{{members}}</p><p>{{mystery}}</p>",
      cityName: "London",
      introductionDate: "2026-08-16",
      members,
    });
    expect(rendered.html).toContain("{{mystery}}");
  });

  it("detects unknown placeholders", () => {
    expect(unknownPlaceholders("{{first_name}}", "{{members}} {{mystery}}")).toEqual(["{{mystery}}"]);
  });

  it("default template passes full validation", () => {
    expect(validateTemplateContent(DEFAULT_TEMPLATE_SUBJECT, DEFAULT_TEMPLATE_BODY).ok).toBe(true);
  });
});

describe("renderCoordinationText", () => {
  it("instructs members to reply-all", () => {
    expect(renderCoordinationText()).toContain("reply-all");
    expect(renderCoordinationText()).toContain("not monitored");
  });
});
