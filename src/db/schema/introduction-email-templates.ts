import {
  pgTable,
  text,
  timestamp,
  index,
} from "drizzle-orm/pg-core";

/**
 * Admin-managed email templates for introduction emails. The editable
 * subject/HTML lives on immutable introduction_email_template_versions rows;
 * publishing a template creates a new version. Introduction runs reference a
 * specific template version so sent emails always match an auditable draft.
 */
export const introductionEmailTemplates = pgTable(
  "introduction_email_templates",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    status: text("status").notNull().default("draft"),
    // "draft" | "published"
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("introduction_email_templates_status_idx").on(table.status),
  ]
);

export type IntroductionEmailTemplate = typeof introductionEmailTemplates.$inferSelect;
export type NewIntroductionEmailTemplate = typeof introductionEmailTemplates.$inferInsert;
