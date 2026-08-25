/**
 * Slack notification for first-time paid members from the signup widget.
 *
 * Posted to a dedicated bot + channel on the wlthwlks.slack.com workspace
 * (SLACK_WW_BOT_TOKEN / SLACK_WW_NEW_MEMBERS_CHANNEL), gated by
 * BILLING_ALERTS_TO_SLACK_ENABLED.
 *
 * NEVER throws — a Slack failure must never affect payment confirmation.
 */
import { createSlackClient } from "@/lib/integrations/slack";
import type { AirtableRecord } from "@/lib/integrations/airtable";
import { MEMBER_FIELDS } from "@/lib/ops/airtable-fields";
import {
  findCatalogCityByCode,
  resolveMemberLocationDto,
} from "@/lib/forms/reference-data";
import { getFormFeatureFlags } from "@/lib/forms/feature-flags";

export type NewPaidMemberSlackInput = {
  fullName: string;
  email: string;
  city: string;
  country: string;
};

function fieldStr(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  if (v == null) return "";
  if (Array.isArray(v)) return String(v[0] ?? "").trim();
  return String(v).trim();
}

export function buildNewPaidMemberMessage(input: NewPaidMemberSlackInput): string {
  const name = input.fullName.trim() || "—";
  const email = input.email.trim() || "—";
  const lines = [
    "New 2.0 WW Member [Paid]",
    `An airtable record was automatically created for ${name} (${email}) :blush:`,
  ];

  const city = input.city.trim();
  const country = input.country.trim();
  const location = city && country ? `${city} (${country})` : city || country;
  if (location) {
    lines.push(`:earth_americas: ${location}.`);
  }

  return lines.join("\n");
}

export type NotifySignupPaidResult = { sent: boolean; reason?: string };

function getSlackWwConfig(): { token: string; channel: string } {
  return {
    token: (process.env.SLACK_WW_BOT_TOKEN || "").trim(),
    channel: (process.env.SLACK_WW_NEW_MEMBERS_CHANNEL || "").trim(),
  };
}

/**
 * Send the "New 2.0 WW Member [Paid]" message for a first-time signup payment.
 * No-op (never throws) when the flag / config is missing or Slack fails.
 */
export async function notifySignupPaidMemberOnSlack(
  record: AirtableRecord
): Promise<NotifySignupPaidResult> {
  try {
    if (!getFormFeatureFlags().billingAlertsToSlackEnabled) {
      return { sent: false, reason: "flag_disabled" };
    }

    const cfg = getSlackWwConfig();
    if (!cfg.token || !cfg.channel) {
      return { sent: false, reason: "config_missing" };
    }

    const fields = record.fields;
    const fullName =
      `${fieldStr(fields, MEMBER_FIELDS.firstName)} ${fieldStr(fields, MEMBER_FIELDS.lastName)}`.trim() ||
      fieldStr(fields, MEMBER_FIELDS.name);
    const email = fieldStr(fields, MEMBER_FIELDS.email);

    const loc = await resolveMemberLocationDto(fields);
    let city = loc.city;
    let country = "";
    if (loc.cityCode) {
      const cat = await findCatalogCityByCode(loc.cityCode);
      if (cat) {
        city = cat.label || city;
        country = cat.countryLabel;
      }
    }

    const text = buildNewPaidMemberMessage({ fullName, email, city, country });
    const slack = createSlackClient({ botToken: cfg.token });
    await slack.postMessage(cfg.channel, text);

    console.error(
      JSON.stringify({
        event: "signup_paid_slack_sent",
        channel: cfg.channel,
      })
    );
    return { sent: true };
  } catch (err) {
    console.error(
      JSON.stringify({
        event: "signup_paid_slack_failed",
        message: err instanceof Error ? err.message : String(err),
      })
    );
    return { sent: false, reason: "error" };
  }
}
