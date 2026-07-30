"use client";

import {
  App,
  Button,
  Descriptions,
  Divider,
  Drawer,
  Space,
  Tag,
  Typography,
} from "antd";
import { IssueSeverityTag } from "@/components/ops/IssueSeverityTag";
import type { MemberHealthRow, MemberIssue } from "@/lib/ops/member-health-types";

export type OpenedFromIssue = {
  issue: MemberIssue;
  detectedAt?: string;
};

export function MemberDetailsDrawer(props: {
  member: MemberHealthRow | null;
  open: boolean;
  onClose: () => void;
  openedFromIssue?: OpenedFromIssue | null;
}) {
  const { message } = App.useApp();
  const selected = props.member;

  const copyText = async (value: string, label: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable");
      }
      await navigator.clipboard.writeText(value);
      message.success(`${label} copied`);
    } catch {
      message.error(`Could not copy ${label.toLowerCase()}`);
    }
  };

  const CopyBtn = ({ value, label }: { value: string; label: string }) =>
    value ? (
      <Button
        size="small"
        type="link"
        onClick={(e) => {
          e.stopPropagation();
          void copyText(value, label);
        }}
      >
        Copy
      </Button>
    ) : null;

  return (
    <Drawer
      open={props.open}
      onClose={props.onClose}
      size="large"
      title={selected?.name || "Member"}
      destroyOnHidden
    >
      {selected && (
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {props.openedFromIssue && (
            <>
              <Typography.Text strong>Opened from issue</Typography.Text>
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="Issue label">
                  {props.openedFromIssue.issue.label}
                </Descriptions.Item>
                <Descriptions.Item label="Issue code">
                  <Typography.Text code>
                    {props.openedFromIssue.issue.code}
                  </Typography.Text>
                  <CopyBtn value={props.openedFromIssue.issue.code} label="Issue code" />
                </Descriptions.Item>
                <Descriptions.Item label="Severity">
                  <IssueSeverityTag severity={props.openedFromIssue.issue.severity} />
                </Descriptions.Item>
                <Descriptions.Item label="Systems">
                  {props.openedFromIssue.issue.systems.join(", ")}
                </Descriptions.Item>
                <Descriptions.Item label="Explanation">
                  {props.openedFromIssue.issue.explanation}
                </Descriptions.Item>
                <Descriptions.Item label="Recommended action">
                  {props.openedFromIssue.issue.recommendedAction}
                </Descriptions.Item>
                {props.openedFromIssue.detectedAt && (
                  <Descriptions.Item label="Detection time">
                    {props.openedFromIssue.detectedAt}
                  </Descriptions.Item>
                )}
              </Descriptions>
              <Divider style={{ margin: "8px 0" }} />
            </>
          )}

          <Typography.Text strong>Identity</Typography.Text>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Name">{selected.name || "—"}</Descriptions.Item>
            <Descriptions.Item label="Primary email">
              {selected.primaryEmail || "—"}
              <CopyBtn value={selected.primaryEmail} label="Email" />
            </Descriptions.Item>
            <Descriptions.Item label="Airtable record ID">
              {selected.airtableRecordId || (selected.stripeOnly ? "Stripe-only" : "—")}
              {selected.airtableRecordId && (
                <CopyBtn value={selected.airtableRecordId} label="Record ID" />
              )}
            </Descriptions.Item>
            <Descriptions.Item label="City">{selected.city || "—"}</Descriptions.Item>
            <Descriptions.Item label="Membership">
              {selected.membership || "—"}
            </Descriptions.Item>
            <Descriptions.Item label="Payment">{selected.payment || "—"}</Descriptions.Item>
            <Descriptions.Item label="Date joined">
              {selected.dateJoined || "—"}
            </Descriptions.Item>
            <Descriptions.Item label="Cancellation date">
              {selected.cancellationDate || "—"}
            </Descriptions.Item>
          </Descriptions>

          <Typography.Text strong>Service access</Typography.Text>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Service access until">
              {selected.serviceAccessUntil || "—"}
            </Descriptions.Item>
            <Descriptions.Item label="Current access">
              {selected.hasCurrentServiceAccess ? (
                <Tag color="success">Yes</Tag>
              ) : (
                <Tag>No</Tag>
              )}
            </Descriptions.Item>
          </Descriptions>

          <Typography.Text strong>Stripe</Typography.Text>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Stripe Customer ID">
              {selected.stripeCustomerId || "—"}
              {selected.stripeCustomerId && (
                <CopyBtn value={selected.stripeCustomerId} label="Stripe ID" />
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Stripe customer email">
              {selected.stripeCustomerEmail || "—"}
            </Descriptions.Item>
            <Descriptions.Item label="Latest qualifying paid-through">
              {selected.latestQualifyingPaidThrough || "Not checked"}
            </Descriptions.Item>
          </Descriptions>

          <Typography.Text strong>Slack</Typography.Text>
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Slack Email">
              {selected.slackEmail || "—"}
              {selected.slackEmail && (
                <CopyBtn value={selected.slackEmail} label="Slack Email" />
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Identity state">
              <Tag>{selected.slackIdentityState.replace(/_/g, " ")}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Active Slack user ID">
              {selected.activeSlackUserId || "—"}
              {selected.activeSlackUserId && (
                <CopyBtn value={selected.activeSlackUserId} label="Slack user ID" />
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Slack display name">
              {selected.activeSlackDisplayName || "—"}
            </Descriptions.Item>
            <Descriptions.Item label="City Slack channel">
              {selected.cityChannelName || "—"}{" "}
              {selected.cityChannelId ? `(${selected.cityChannelId})` : ""}
            </Descriptions.Item>
            <Descriptions.Item label="City-channel membership">
              {selected.cityChannelMembership}
            </Descriptions.Item>
            <Descriptions.Item label="all-wlth-wlks membership">
              {selected.allMembersChannelMembership}
            </Descriptions.Item>
          </Descriptions>

          <Typography.Text strong>Issues</Typography.Text>
          <div>
            Highest severity:{" "}
            <IssueSeverityTag severity={selected.highestSeverity} />
          </div>
          <div style={{ marginBottom: 8 }}>
            <Typography.Text type="secondary">Recommended next action</Typography.Text>
            <div>{selected.recommendedNextAction || "—"}</div>
          </div>
          {selected.issues.length === 0 && (
            <Typography.Text type="secondary">No issues detected.</Typography.Text>
          )}
          {selected.issues.map((i) => (
            <div
              key={i.code}
              style={{
                marginTop: 8,
                padding: 10,
                border: "1px solid rgba(0,0,0,0.06)",
                borderRadius: 8,
              }}
            >
              <Space wrap>
                <IssueSeverityTag severity={i.severity} />
                <Typography.Text strong>{i.label}</Typography.Text>
                <Typography.Text type="secondary" code>
                  {i.code}
                </Typography.Text>
              </Space>
              <div style={{ fontSize: 12, color: "rgba(0,0,0,0.55)", marginTop: 4 }}>
                {i.explanation}
              </div>
              <div style={{ fontSize: 12, marginTop: 4 }}>{i.recommendedAction}</div>
              <div style={{ fontSize: 11, marginTop: 4, color: "rgba(0,0,0,0.45)" }}>
                Systems: {i.systems.join(", ")}
              </div>
            </div>
          ))}
        </Space>
      )}
    </Drawer>
  );
}
