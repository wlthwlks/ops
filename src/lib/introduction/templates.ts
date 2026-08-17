import { desc, eq } from "drizzle-orm";
import type { AppDb } from "@/db";
import {
  introductionEmailTemplates,
  introductionEmailTemplateVersions,
  introductionConfig,
  type IntroductionEmailTemplate,
  type IntroductionEmailTemplateVersion,
} from "@/db/schema";
import { GLOBAL_CONFIG_KEYS, getGlobalIntroductionConfig } from "./settings";

/**
 * Admin-managed email templates for introduction emails. Every save creates
 * an immutable version; publishing validates the required placeholders and
 * flips the template to published. Runs reference a specific version so
 * sent emails always match an auditable draft.
 */

export const DEFAULT_TEMPLATE_NAME = "Introduction email";
export const DEFAULT_TEMPLATE_SUBJECT = "Meet your {{city}} introductions";

export const DEFAULT_TEMPLATE_BODY = `
<p>Hi {{first_name}},</p>
<p>Welcome to your {{city}} introductions for {{introduction_date}}. Here's who you've been matched with:</p>
{{members}}
{{why_you_matched}}
<p>{{coordination_text}}</p>
<p>Enjoy the walk,<br/>WLTH WLKS</p>
`.trim();

export const KNOWN_PLACEHOLDERS = [
  "{{first_name}}",
  "{{city}}",
  "{{introduction_date}}",
  "{{members}}",
  "{{why_you_matched}}",
  "{{coordination_text}}",
  "{{meetup_suggestion}}",
  "{{group_size_word}}",
] as const;

export const REQUIRED_BODY_PLACEHOLDERS: readonly string[] = ["{{members}}"];

const PLACEHOLDER_PATTERN = /\{\{\s*[a-z_]+\s*\}\}/gi;

export class EmailTemplateError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "EmailTemplateError";
  }
}

export interface TemplateValidation {
  ok: boolean;
  issues: string[];
}

/** Extract the placeholder tokens present in a template string. */
export function extractPlaceholders(value: string): string[] {
  const matches = value.match(PLACEHOLDER_PATTERN) ?? [];
  return [...new Set(matches.map((m) => m.toLowerCase()))];
}

/**
 * Full validation used before publishing: required placeholders must be
 * present and no unknown placeholder tokens are allowed.
 */
export function validateTemplateContent(
  subject: string,
  bodyHtml: string
): TemplateValidation {
  const issues: string[] = [];
  if (!subject.trim()) {
    issues.push("Subject is required");
  }
  if (!bodyHtml.trim()) {
    issues.push("Body is required");
  }
  const bodyTokens = extractPlaceholders(bodyHtml);
  const subjectTokens = extractPlaceholders(subject);
  for (const required of REQUIRED_BODY_PLACEHOLDERS) {
    if (!bodyTokens.includes(required)) {
      issues.push(`Body must include the ${required} placeholder`);
    }
  }
  const known = new Set<string>(KNOWN_PLACEHOLDERS);
  for (const token of [...bodyTokens, ...subjectTokens]) {
    if (!known.has(token)) {
      issues.push(`Unknown placeholder ${token}`);
    }
  }
  return { ok: issues.length === 0, issues };
}

export async function getEmailTemplate(
  db: AppDb,
  id: string
): Promise<IntroductionEmailTemplate | null> {
  const rows = await db
    .select()
    .from(introductionEmailTemplates)
    .where(eq(introductionEmailTemplates.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getEmailTemplateVersion(
  db: AppDb,
  versionId: string
): Promise<IntroductionEmailTemplateVersion | null> {
  const rows = await db
    .select()
    .from(introductionEmailTemplateVersions)
    .where(eq(introductionEmailTemplateVersions.id, versionId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getLatestTemplateVersion(
  db: AppDb,
  templateId: string
): Promise<IntroductionEmailTemplateVersion | null> {
  const rows = await db
    .select()
    .from(introductionEmailTemplateVersions)
    .where(eq(introductionEmailTemplateVersions.templateId, templateId))
    .orderBy(desc(introductionEmailTemplateVersions.version))
    .limit(1);
  return rows[0] ?? null;
}

export async function listEmailTemplates(db: AppDb) {
  const templates = await db
    .select()
    .from(introductionEmailTemplates)
    .orderBy(desc(introductionEmailTemplates.updatedAt));
  const result = [];
  for (const template of templates) {
    result.push({ template, latestVersion: await getLatestTemplateVersion(db, template.id) });
  }
  return result;
}

export async function listTemplateVersions(
  db: AppDb,
  templateId: string
): Promise<IntroductionEmailTemplateVersion[]> {
  return db
    .select()
    .from(introductionEmailTemplateVersions)
    .where(eq(introductionEmailTemplateVersions.templateId, templateId))
    .orderBy(desc(introductionEmailTemplateVersions.version));
}

export async function createEmailTemplate(
  db: AppDb,
  input: { name: string; subject: string; bodyHtml: string; createdBy?: string }
): Promise<{ template: IntroductionEmailTemplate; version: IntroductionEmailTemplateVersion }> {
  const name = input.name.trim();
  if (!name) throw new EmailTemplateError("INVALID_TEMPLATE", "Template name is required");
  const templateId = crypto.randomUUID();
  const [template] = await db
    .insert(introductionEmailTemplates)
    .values({ id: templateId, name, status: "draft" })
    .returning();
  const version = await insertTemplateVersion(db, {
    templateId,
    subject: input.subject,
    bodyHtml: input.bodyHtml,
    createdBy: input.createdBy,
  });
  return { template, version };
}

async function insertTemplateVersion(
  db: AppDb,
  input: { templateId: string; subject: string; bodyHtml: string; createdBy?: string }
): Promise<IntroductionEmailTemplateVersion> {
  const latest = await getLatestTemplateVersion(db, input.templateId);
  const version = (latest?.version ?? 0) + 1;
  const [row] = await db
    .insert(introductionEmailTemplateVersions)
    .values({
      id: crypto.randomUUID(),
      templateId: input.templateId,
      version,
      subject: input.subject,
      bodyHtml: input.bodyHtml,
      senderFrom: null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  return row;
}

export async function saveEmailTemplateVersion(
  db: AppDb,
  templateId: string,
  input: { subject: string; bodyHtml: string; createdBy?: string }
): Promise<IntroductionEmailTemplateVersion> {
  const template = await getEmailTemplate(db, templateId);
  if (!template) {
    throw new EmailTemplateError("TEMPLATE_NOT_FOUND", `Template ${templateId} not found`);
  }
  if (!input.subject.trim() || !input.bodyHtml.trim()) {
    throw new EmailTemplateError("INVALID_TEMPLATE", "Subject and body are required");
  }
  return insertTemplateVersion(db, { templateId, ...input });
}

export async function publishEmailTemplate(
  db: AppDb,
  templateId: string
): Promise<IntroductionEmailTemplateVersion> {
  const template = await getEmailTemplate(db, templateId);
  if (!template) {
    throw new EmailTemplateError("TEMPLATE_NOT_FOUND", `Template ${templateId} not found`);
  }
  const latest = await getLatestTemplateVersion(db, templateId);
  if (!latest) {
    throw new EmailTemplateError("TEMPLATE_HAS_NO_VERSION", "Template has no draft version");
  }
  const validation = validateTemplateContent(latest.subject, latest.bodyHtml);
  if (!validation.ok) {
    throw new EmailTemplateError("TEMPLATE_INVALID", validation.issues.join("; "));
  }
  await db
    .update(introductionEmailTemplates)
    .set({ status: "published", updatedAt: new Date() })
    .where(eq(introductionEmailTemplates.id, templateId));
  return latest;
}

/** Copy an old version's content into a new version and return to draft. */
export async function restoreEmailTemplateVersion(
  db: AppDb,
  templateId: string,
  versionId: string,
  createdBy?: string
): Promise<IntroductionEmailTemplateVersion> {
  const template = await getEmailTemplate(db, templateId);
  if (!template) {
    throw new EmailTemplateError("TEMPLATE_NOT_FOUND", `Template ${templateId} not found`);
  }
  const source = await getEmailTemplateVersion(db, versionId);
  if (!source || source.templateId !== templateId) {
    throw new EmailTemplateError("TEMPLATE_VERSION_NOT_FOUND", `Version ${versionId} not found`);
  }
  await db
    .update(introductionEmailTemplates)
    .set({ status: "draft", updatedAt: new Date() })
    .where(eq(introductionEmailTemplates.id, templateId));
  return insertTemplateVersion(db, {
    templateId,
    subject: source.subject,
    bodyHtml: source.bodyHtml,
    createdBy,
  });
}

export interface EffectiveEmailTemplate {
  versionId: string | null;
  subject: string;
  bodyHtml: string;
  senderFrom: string;
}

/**
 * Resolve the template a run uses: explicit version id, else the globally
 * configured default template's latest version, else the built-in defaults.
 * The visible sender comes from global config (template-level overrides
 * are not supported yet).
 */
export async function resolveEffectiveTemplate(
  db: AppDb,
  templateVersionId?: string | null
): Promise<EffectiveEmailTemplate> {
  const global = await getGlobalIntroductionConfig(db);

  if (templateVersionId) {
    const version = await getEmailTemplateVersion(db, templateVersionId);
    if (!version) {
      throw new EmailTemplateError(
        "TEMPLATE_VERSION_NOT_FOUND",
        `Template version ${templateVersionId} not found`
      );
    }
    return {
      versionId: version.id,
      subject: version.subject,
      bodyHtml: version.bodyHtml,
      senderFrom: version.senderFrom || global.senderFrom,
    };
  }

  if (global.defaultTemplateId) {
    const latest = await getLatestTemplateVersion(db, global.defaultTemplateId);
    if (latest) {
      return {
        versionId: latest.id,
        subject: latest.subject,
        bodyHtml: latest.bodyHtml,
        senderFrom: latest.senderFrom || global.senderFrom,
      };
    }
  }

  return {
    versionId: null,
    subject: DEFAULT_TEMPLATE_SUBJECT,
    bodyHtml: DEFAULT_TEMPLATE_BODY,
    senderFrom: global.senderFrom,
  };
}

/** Create and publish the built-in default template when none exists. */
export async function ensureDefaultTemplate(
  db: AppDb,
  opts: { createdBy?: string } = {}
): Promise<IntroductionEmailTemplateVersion | null> {
  const existing = await listEmailTemplates(db);
  if (existing.length > 0) return null;

  const { template, version } = await createEmailTemplate(db, {
    name: DEFAULT_TEMPLATE_NAME,
    subject: DEFAULT_TEMPLATE_SUBJECT,
    bodyHtml: DEFAULT_TEMPLATE_BODY,
    createdBy: opts.createdBy,
  });
  await publishEmailTemplate(db, template.id);
  await db
    .insert(introductionConfig)
    .values({
      key: GLOBAL_CONFIG_KEYS.defaultTemplateId,
      valueJson: template.id,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: introductionConfig.key,
      set: {
        valueJson: template.id,
        updatedAt: new Date(),
      },
    });
  return version;
}
