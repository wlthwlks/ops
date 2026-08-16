import {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { introductionEmailTemplates } from "./introduction-email-templates";

/**
 * Immutable snapshot of an email template at publish time. `subject` and
 * `body_html` use controlled placeholders such as {{first_name}}, {{city}},
 * {{introduction_date}}, {{members}}, {{why_you_matched}} and
 * {{coordination_text}}.
 */
export const introductionEmailTemplateVersions = pgTable(
  "introduction_email_template_versions",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => introductionEmailTemplates.id),
    version: integer("version").notNull(),
    subject: text("subject").notNull(),
    bodyHtml: text("body_html").notNull(),
    senderFrom: text("sender_from"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("introduction_email_template_versions_uidx")
      .on(table.templateId, table.version),
    index("introduction_email_template_versions_template_idx").on(table.templateId),
  ]
);

export type IntroductionEmailTemplateVersion =
  typeof introductionEmailTemplateVersions.$inferSelect;
export type NewIntroductionEmailTemplateVersion =
  typeof introductionEmailTemplateVersions.$inferInsert;
