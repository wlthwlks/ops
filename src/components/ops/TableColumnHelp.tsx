"use client";

import { Tooltip } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";

export function TableColumnHelp(props: {
  title: string;
  content: string;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span>{props.title}</span>
      <Tooltip title={props.content} placement="top">
        <button
          type="button"
          aria-label={`About column ${props.title}`}
          tabIndex={0}
          onClick={(e) => e.stopPropagation()}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            cursor: "help",
            color: "rgba(0,0,0,0.45)",
            lineHeight: 1,
            display: "inline-flex",
          }}
        >
          <InfoCircleOutlined aria-hidden />
        </button>
      </Tooltip>
    </span>
  );
}

export const MEMBER_COLUMN_HELP = {
  access:
    "Calculated with the shared hasServiceAccess rule. A member has current access when Membership is Active and Payment is Paid, or Service access until has not expired. A cancelled member may correctly retain access until the paid date ends.",
  stripe:
    "Linked means an exact Stripe Customer ID exists on the Airtable record. It does not by itself prove that every invoice is valid or paid. Full invoice qualification belongs to the Billing Integrity scan.",
  slack:
    "Trusted Slack identity-resolution state (matched by Slack Email, primary email, ambiguous, deactivated, stale Slack Email, not found). It does not necessarily mean the person is in every required Slack channel.",
  severity:
    "Highest-priority issue currently detected for this member: Critical, High, Medium, Informational, or no issue.",
  nextAction:
    "Recommended response to the highest-priority actionable issue. Guidance only — not proof that an automated action should run without review.",
} as const;
