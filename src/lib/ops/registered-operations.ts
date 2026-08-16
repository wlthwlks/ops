/**
 * Catalogue of maintenance / diagnostic operations for the Ops centre.
 * Only registered operations may run — no arbitrary shell execution.
 */
import type { Op, OpContext, OpResult } from "@/lib/types";
import { syncSignups } from "@/lib/ops/sync-signups";
import { donutTracker } from "@/lib/ops/donut-tracker";
import { memberExport } from "@/lib/ops/member-export";
import { syncToPinecone } from "@/lib/ops/sync-to-pinecone";
import { syncIntroProfiles } from "@/lib/ops/sync-intro-profiles";
import { dailyMatchMessage } from "@/lib/ops/daily-match-message";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createSlackClient } from "@/lib/integrations/slack";
import { MEMBERS_TABLE, MEMBER_LIST_FIELDS, SLACK_CHANNELS_TABLE, SLACK_CHANNEL_LIST_FIELDS } from "@/lib/ops/airtable-fields";
import { hasServiceAccess } from "@/lib/introduction/service-access";
import { getAllMembersChannelConfig } from "@/lib/ops/member-health";

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

function envPresent(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

async function diagnosticAirtable(ctx: OpContext): Promise<OpResult> {
  await ctx.log("Checking Airtable connection…");
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    return { success: false, summary: "AIRTABLE_GET_DATA_TOKEN or AIRTABLE_BASE_ID missing" };
  }
  const client = createAirtableClient({ apiKey: token, baseId });
  const members = await client.listRecords(MEMBERS_TABLE, {
    fields: MEMBER_LIST_FIELDS.slice(0, 5),
    maxRecords: 1,
  });
  await ctx.log(`Airtable OK — sample Members fetch returned ${members.length} row(s)`);
  return { success: true, summary: "Airtable connection healthy", recordsProcessed: members.length };
}

async function diagnosticSlack(ctx: OpContext): Promise<OpResult> {
  await ctx.log("Checking Slack auth and scopes…");
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return { success: false, summary: "SLACK_BOT_TOKEN missing" };
  const slack = createSlackClient({ botToken: token });
  const auth = await slack.authTest();
  await ctx.log(`Team: ${auth.team || "(unknown)"}`);
  await ctx.log(`Scopes: ${auth.scopes.join(", ") || "(none reported)"}`);
  const required = ["users:read", "users:read.email", "channels:read", "groups:read"];
  const missing = required.filter((s) => !auth.scopes.includes(s));
  if (missing.length) {
    await ctx.log(`Missing recommended scopes: ${missing.join(", ")}`);
    return {
      success: true,
      summary: `Slack auth OK with missing scopes: ${missing.join(", ")}`,
    };
  }
  return { success: true, summary: "Slack auth and core scopes healthy" };
}

async function diagnosticEnv(ctx: OpContext): Promise<OpResult> {
  const names = [
    "AIRTABLE_GET_DATA_TOKEN",
    "AIRTABLE_BASE_ID",
    "SLACK_BOT_TOKEN",
    "SLACK_ALL_MEMBERS_CHANNEL_ID",
    "STRIPE_SECRET_KEY",
    "STRIPE_MEMBERSHIP_PRICE_IDS",
    "RESEND_API_KEY",
    "RESEND_FROM_EMAIL",
    "POSTGRES_URL",
    "INTRODUCTIONS_MODE",
    "CLERK_SECRET_KEY",
    "PINECONE_API_KEY",
    "OPENAI_API_KEY",
  ];
  let present = 0;
  for (const n of names) {
    const ok = envPresent(n);
    if (ok) present++;
    await ctx.log(`${n}: ${ok ? "set" : "missing"}`);
  }
  return {
    success: true,
    summary: `${present}/${names.length} environment variables present (values not shown)`,
    recordsProcessed: present,
  };
}

async function diagnosticMemberCounts(ctx: OpContext): Promise<OpResult> {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    return { success: false, summary: "Airtable not configured" };
  }
  const client = createAirtableClient({ apiKey: token, baseId });
  const members = await client.listRecords(MEMBERS_TABLE, { fields: MEMBER_LIST_FIELDS });
  const ref = new Date();
  let activePaid = 0;
  let withAccess = 0;
  for (const r of members) {
    const membership = fieldStr(r.fields, "Membership");
    const payment = fieldStr(r.fields, "Payment");
    const until = fieldStr(r.fields, "Service access until");
    if (membership === "Active" && payment === "Paid") activePaid++;
    if (hasServiceAccess(membership, payment, until || null, ref)) withAccess++;
  }
  await ctx.log(`Total Members: ${members.length}`);
  await ctx.log(`Active+Paid: ${activePaid}`);
  await ctx.log(`Current service access: ${withAccess}`);
  return {
    success: true,
    summary: `${members.length} members; ${withAccess} with service access; ${activePaid} Active+Paid`,
    recordsProcessed: members.length,
  };
}

async function diagnosticChannels(ctx: OpContext): Promise<OpResult> {
  const token = process.env.AIRTABLE_GET_DATA_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  if (!token || !baseId) {
    return { success: false, summary: "Airtable not configured" };
  }
  const client = createAirtableClient({ apiKey: token, baseId });
  const channels = await client.listRecords(SLACK_CHANNELS_TABLE, {
    fields: SLACK_CHANNEL_LIST_FIELDS,
  });
  let withId = 0;
  for (const ch of channels) {
    if (fieldStr(ch.fields, "Slack Channel ID")) withId++;
  }
  const all = getAllMembersChannelConfig();
  await ctx.log(`Slack channels rows: ${channels.length}`);
  await ctx.log(`With Slack Channel ID: ${withId}`);
  await ctx.log(
    `all-members channel: ${all.id ? `${all.name} (${all.id})` : "NOT CONFIGURED"}`
  );
  return {
    success: true,
    summary: `${channels.length} channel rows; ${withId} with Slack IDs; all-members ${all.id ? "configured" : "missing"}`,
    recordsProcessed: channels.length,
  };
}

function cliOnlyStub(summary: string): (ctx: OpContext) => Promise<OpResult> {
  return async (ctx) => {
    await ctx.log(summary);
    await ctx.log("This operation is CLI-only from the dashboard. Use the documented npm script.");
    return { success: false, summary: "CLI-only operation — not executed from dashboard" };
  };
}

function withMeta(base: Op, meta: Partial<Op>): Op {
  return { ...base, ...meta };
}

export const registeredOperations: Op[] = [
  withMeta(syncSignups, {
    category: "airtable_maintenance",
    riskLevel: "write",
    requiresLiveMode: true,
    requiresAdmin: true,
    summary: "Sync new signups into operational systems",
    productionEnabled: true,
  }),
  withMeta(donutTracker, {
    category: "legacy_disabled",
    riskLevel: "deprecated",
    deprecated: true,
    productionEnabled: false,
    summary: "Legacy Donut tracker — replaced by recurring city intros",
    whenNotToRun: "Do not run in production. Use Recurring Introductions instead.",
  }),
  withMeta(memberExport, {
    category: "airtable_maintenance",
    riskLevel: "safe_read",
    supportsReadOnly: true,
    requiresAdmin: true,
    summary: "Export member data snapshot",
    productionEnabled: true,
  }),
  withMeta(syncToPinecone, {
    category: "pinecone_matching",
    riskLevel: "high_risk",
    requiresLiveMode: true,
    requiresAdmin: true,
    productionEnabled: false,
    summary: "Sync member embeddings to Pinecone (affects matching)",
    whenNotToRun: "Do not run unless explicitly approved — changes production matching data.",
  }),
  withMeta(syncIntroProfiles, {
    category: "pinecone_matching",
    riskLevel: "high_risk",
    requiresLiveMode: true,
    requiresAdmin: true,
    productionEnabled: false,
    summary: "Sync semantic intro profiles to the unified-engine Pinecone namespace",
    whenNotToRun: "Do not run unless explicitly approved — changes production matching data.",
  }),
  withMeta(dailyMatchMessage, {
    category: "introduction_history",
    riskLevel: "write",
    requiresLiveMode: true,
    requiresAdmin: true,
    productionEnabled: true,
    summary: "Send match introduction messages",
  }),

  // Diagnostics
  {
    slug: "diag-airtable",
    name: "Airtable connection check",
    description: "Verify Airtable credentials and Members table access",
    category: "health_checks",
    riskLevel: "safe_read",
    supportsReadOnly: true,
    requiresAdmin: false,
    productionEnabled: true,
    summary: "Safe Airtable connectivity probe",
    whenToRun: "When Airtable errors appear or after credential rotation",
    dataSources: ["Airtable"],
    sideEffects: ["None (read-only)"],
    commandEquivalent: "(dashboard only)",
    run: diagnosticAirtable,
  },
  {
    slug: "diag-slack",
    name: "Slack auth/scope check",
    description: "Verify Slack bot token and report OAuth scopes",
    category: "health_checks",
    riskLevel: "safe_read",
    supportsReadOnly: true,
    requiresAdmin: false,
    productionEnabled: true,
    summary: "Safe Slack auth.test probe",
    dataSources: ["Slack"],
    sideEffects: ["None (read-only)"],
    run: diagnosticSlack,
  },
  {
    slug: "diag-env",
    name: "Environment variable check",
    description: "Report which required env vars are set (never shows values)",
    category: "health_checks",
    riskLevel: "safe_read",
    supportsReadOnly: true,
    requiresAdmin: true,
    productionEnabled: true,
    summary: "Names only — values never logged",
    run: diagnosticEnv,
  },
  {
    slug: "diag-member-counts",
    name: "Count members by access",
    description: "Count Active/Paid and service-access eligible members",
    category: "health_checks",
    riskLevel: "safe_read",
    supportsReadOnly: true,
    requiresAdmin: false,
    productionEnabled: true,
    run: diagnosticMemberCounts,
  },
  {
    slug: "diag-channels",
    name: "Check channel configuration",
    description: "Summarise Slack channel Airtable rows and all-members config",
    category: "health_checks",
    riskLevel: "safe_read",
    supportsReadOnly: true,
    requiresAdmin: false,
    productionEnabled: true,
    run: diagnosticChannels,
  },

  // CLI-backed maintenance (documented; apply variants CLI-only until durable batches exist)
  {
    slug: "airtable-update-intro-fields",
    name: "Airtable introduction fields",
    description: "Check/update Airtable intro field schema",
    category: "airtable_maintenance",
    riskLevel: "cli_only",
    cliOnly: true,
    productionEnabled: false,
    commandEquivalent: "npm run airtable:update-intro-fields",
    whenToRun: "Once when introducing new intro fields to Airtable",
    whenNotToRun: "Do not re-run casually in production without review",
    summary: "Schema maintenance for introduction fields",
    run: cliOnlyStub("Use: npm run airtable:update-intro-fields"),
  },
  {
    slug: "airtable-import-history",
    name: "Introduction history import",
    description: "Import historical introduction tracking (affects repeat exclusion)",
    category: "introduction_history",
    riskLevel: "cli_only",
    cliOnly: true,
    productionEnabled: false,
    commandEquivalent: "npm run airtable:import-history",
    whenToRun: "One-time historical import with dry-run first",
    summary: "Imports history; may affect repeat introduction exclusion",
    availableVariants: [
      { id: "dry_run", label: "Audit / dry-run", riskLevel: "dry_run" },
      {
        id: "apply",
        label: "Apply",
        riskLevel: "high_risk",
        requiresLiveMode: true,
        confirmationPhrase: "IMPORT HISTORY",
      },
    ],
    run: cliOnlyStub("Use: npm run airtable:import-history (dry-run first)"),
  },
  {
    slug: "airtable-backfill-service-access",
    name: "Service-access backfill",
    description: "Calculate paid-through from Stripe invoices; never shortens later dates",
    category: "billing_stripe",
    riskLevel: "cli_only",
    cliOnly: true,
    productionEnabled: false,
    commandEquivalent: "npm run airtable:backfill-service-access",
    whenToRun: "When Service access until is behind Stripe paid-through",
    sideEffects: ["Updates existing Airtable members", "Does not create members"],
    summary: "Stripe invoice → Service access until (monotonic)",
    availableVariants: [
      { id: "dry_run", label: "Dry run", riskLevel: "dry_run" },
      { id: "one_customer", label: "One Stripe customer test", riskLevel: "write" },
      { id: "apply", label: "Controlled apply", riskLevel: "high_risk", requiresLiveMode: true },
    ],
    run: cliOnlyStub("Use: npm run airtable:backfill-service-access"),
  },
  {
    slug: "airtable-reconcile-stripe",
    name: "Stripe Customer ID reconciliation",
    description: "Link unique email matches; block ambiguous candidates",
    category: "billing_stripe",
    riskLevel: "cli_only",
    cliOnly: true,
    productionEnabled: false,
    commandEquivalent: "npm run airtable:reconcile-stripe-customers",
    summary: "Exact Stripe ID priority; unique email candidates only",
    availableVariants: [
      { id: "dry_run", label: "Dry run", riskLevel: "dry_run" },
      { id: "apply_unique", label: "Apply unique safe links", riskLevel: "write", requiresLiveMode: true },
    ],
    run: cliOnlyStub("Use: npm run airtable:reconcile-stripe-customers"),
  },
  {
    slug: "airtable-historical-stripe-repair",
    name: "Historical Stripe repair",
    description: "Dry-run / apply links only. Create-missing remains CLI-only emergency.",
    category: "billing_stripe",
    riskLevel: "cli_only",
    cliOnly: true,
    productionEnabled: false,
    commandEquivalent:
      "npm run airtable:historical-stripe-repair",
    whenNotToRun: "Never use dashboard to create Airtable members from Stripe",
    summary: "Links only in dashboard catalogue; member creation remains emergency CLI-only",
    availableVariants: [
      { id: "dry_run", label: "Dry run", riskLevel: "dry_run" },
      { id: "apply_links", label: "Apply links only", riskLevel: "high_risk", requiresLiveMode: true },
    ],
    run: cliOnlyStub(
      "Use: npm run airtable:historical-stripe-repair. --create-missing is CLI-only and must not be run from the dashboard."
    ),
  },
  {
    slug: "airtable-repair-city-relations",
    name: "City/channel relationship repair",
    description: "Audit and repair Members → Cities → Slack channels links",
    category: "city_relationships",
    riskLevel: "cli_only",
    cliOnly: true,
    productionEnabled: false,
    commandEquivalent: "npm run airtable:repair-city-relations",
    whenToRun: "When city channel configuration issues appear",
    summary: "Phased repair: audit → cities → channels → member links; merge is high-risk separate",
    availableVariants: [
      { id: "audit", label: "Audit", riskLevel: "safe_read" },
      { id: "dry_run", label: "Dry run", riskLevel: "dry_run" },
      { id: "apply_cities", label: "Apply City records", riskLevel: "write", requiresLiveMode: true },
      { id: "apply_channels", label: "Apply channel relationships", riskLevel: "write", requiresLiveMode: true },
      { id: "apply_member_links", label: "Apply Member City links", riskLevel: "write", requiresLiveMode: true },
      {
        id: "merge_duplicates",
        label: "Merge duplicates (high risk)",
        riskLevel: "destructive",
        requiresLiveMode: true,
        confirmationPhrase: "MERGE DUPLICATES",
      },
    ],
    run: cliOnlyStub("Use: npm run airtable:repair-city-relations -- --audit"),
  },
];
