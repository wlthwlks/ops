import { describe, it, expect, afterAll, beforeAll, afterEach } from "vitest";
import { createTestDb, resetIntroductionsV2Tables } from "../../helpers/test-db";
import {
  DEFAULT_TEMPLATE_BODY,
  DEFAULT_TEMPLATE_NAME,
  DEFAULT_TEMPLATE_SUBJECT,
  EmailTemplateError,
  createEmailTemplate,
  ensureDefaultTemplate,
  extractPlaceholders,
  getLatestTemplateVersion,
  listEmailTemplates,
  publishEmailTemplate,
  resolveEffectiveTemplate,
  restoreEmailTemplateVersion,
  saveEmailTemplateVersion,
  validateTemplateContent,
} from "@/lib/introduction/templates";
import { getGlobalIntroductionConfig } from "@/lib/introduction/settings";
import { eq } from "drizzle-orm";
import { introductionEmailTemplates } from "@/db/schema";

let db: Awaited<ReturnType<typeof createTestDb>>["db"];
let close: () => Promise<void>;

const VALID_BODY = "<p>Hi {{first_name}}</p>{{members}}{{why_you_matched}}<p>{{coordination_text}}</p>";
const VALID_SUBJECT = "Your {{city}} introductions for {{introduction_date}}";

beforeAll(async () => {
  const test = await createTestDb({ introductionsV2: true });
  db = test.db;
  close = test.close;
});

afterAll(async () => {
  await close();
});

afterEach(async () => {
  await resetIntroductionsV2Tables(db);
});

describe("validateTemplateContent", () => {
  it("accepts a body with all required placeholders and no unknowns", () => {
    const result = validateTemplateContent(VALID_SUBJECT, VALID_BODY);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("rejects a missing required placeholder", () => {
    const result = validateTemplateContent(VALID_SUBJECT, "<p>Hi {{first_name}}</p>{{coordination_text}}");
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("{{members}}");
  });

  it("publishes without the optional coordination placeholder", () => {
    const custom = "<p>Hi {{first_name}}</p>{{members}}<p>Use WhatsApp to coordinate.</p>";
    const result = validateTemplateContent(VALID_SUBJECT, custom);
    expect(result.ok).toBe(true);
  });

  it("accepts the new meetup and group-size placeholders", () => {
    const custom =
      "<p>group of {{group_size_word}} — {{meetup_suggestion}}</p>{{members}}";
    expect(validateTemplateContent(VALID_SUBJECT, custom).ok).toBe(true);
  });

  it("rejects unknown placeholders", () => {
    const result = validateTemplateContent(
      VALID_SUBJECT,
      `${VALID_BODY}<p>{{member_loop}}</p>`
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("{{member_loop}}");
  });

  it("requires a non-empty subject and body", () => {
    const result = validateTemplateContent("", "");
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("extracts placeholders case-insensitively", () => {
    expect(extractPlaceholders("<p>{{MEMBERS}}</p>{{Members}}")).toEqual(["{{members}}"]);
  });
});

describe("template lifecycle", () => {
  it("creates draft templates with version 1 and versions increment on save", async () => {
    const { template, version } = await createEmailTemplate(db, {
      name: "Intro",
      subject: VALID_SUBJECT,
      bodyHtml: VALID_BODY,
    });
    expect(template.status).toBe("draft");
    expect(version.version).toBe(1);

    const v2 = await saveEmailTemplateVersion(db, template.id, {
      subject: VALID_SUBJECT,
      bodyHtml: `${VALID_BODY}<p>v2</p>`,
    });
    expect(v2.version).toBe(2);
    expect((await getLatestTemplateVersion(db, template.id))?.version).toBe(2);
  });

  it("publishes only when the latest version validates", async () => {
    const { template, version } = await createEmailTemplate(db, {
      name: "Intro",
      subject: VALID_SUBJECT,
      bodyHtml: VALID_BODY,
    });
    const published = await publishEmailTemplate(db, template.id);
    expect(published.id).toBe(version.id);

    const broken = await saveEmailTemplateVersion(db, template.id, {
      subject: VALID_SUBJECT,
      bodyHtml: "<p>no placeholders</p>",
    });
    expect(broken.version).toBe(2);
    await expect(publishEmailTemplate(db, template.id)).rejects.toThrow(EmailTemplateError);
  });

  it("restore copies an old version and returns the template to draft", async () => {
    const { template, version } = await createEmailTemplate(db, {
      name: "Intro",
      subject: VALID_SUBJECT,
      bodyHtml: VALID_BODY,
    });
    await publishEmailTemplate(db, template.id);
    await saveEmailTemplateVersion(db, template.id, {
      subject: VALID_SUBJECT,
      bodyHtml: `${VALID_BODY}<p>v2 content</p>`,
    });

    const restored = await restoreEmailTemplateVersion(db, template.id, version.id);
    expect(restored.version).toBe(3);
    expect(restored.bodyHtml).toBe(VALID_BODY);

    const templateRow = await db
      .select()
      .from(introductionEmailTemplates)
      .where(eq(introductionEmailTemplates.id, template.id));
    expect(templateRow[0].status).toBe("draft");
  });

  it("rejects saves and publishes for unknown templates", async () => {
    await expect(
      saveEmailTemplateVersion(db, "missing", { subject: "s", bodyHtml: "b" })
    ).rejects.toThrow(EmailTemplateError);
    await expect(publishEmailTemplate(db, "missing")).rejects.toThrow(EmailTemplateError);
  });
});

describe("default template and resolution", () => {
  it("seeds a published default template and wires the global default", async () => {
    const version = await ensureDefaultTemplate(db);
    expect(version).not.toBeNull();
    expect(version?.version).toBe(1);

    const templates = await listEmailTemplates(db);
    expect(templates).toHaveLength(1);
    expect(templates[0].template.name).toBe(DEFAULT_TEMPLATE_NAME);
    expect(templates[0].template.status).toBe("published");

    const config = await getGlobalIntroductionConfig(db);
    expect(config.defaultTemplateId).toBe(templates[0].template.id);
  });

  it("does not double-seed when templates exist", async () => {
    await ensureDefaultTemplate(db);
    const again = await ensureDefaultTemplate(db);
    expect(again).toBeNull();
    expect(await listEmailTemplates(db)).toHaveLength(1);
  });

  it("resolves the built-in defaults when nothing is configured", async () => {
    const effective = await resolveEffectiveTemplate(db, null);
    expect(effective.versionId).toBeNull();
    expect(effective.subject).toBe(DEFAULT_TEMPLATE_SUBJECT);
    expect(effective.bodyHtml).toBe(DEFAULT_TEMPLATE_BODY);
    expect(effective.senderFrom).toContain("noreply@wlthwlks.com");
  });

  it("resolves an explicit version id and errors on unknown ones", async () => {
    const { template, version } = await createEmailTemplate(db, {
      name: "Intro",
      subject: VALID_SUBJECT,
      bodyHtml: VALID_BODY,
    });
    const effective = await resolveEffectiveTemplate(db, version.id);
    expect(effective.versionId).toBe(version.id);
    expect(effective.subject).toBe(VALID_SUBJECT);
    void template;
    await expect(resolveEffectiveTemplate(db, "missing")).rejects.toThrow(EmailTemplateError);
  });

  it("resolves the global default template's latest version", async () => {
    const seeded = await ensureDefaultTemplate(db);
    const effective = await resolveEffectiveTemplate(db, null);
    expect(effective.versionId).toBe(seeded?.id);
  });
});
