"use client";

import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  DatePicker,
  Divider,
  Drawer,
  InputNumber,
  Select,
  Space,
  Typography,
} from "antd";

export type MemberFilterState = {
  city?: string;
  membership?: string;
  payment?: string;
  severity?: string;
  issueCode?: string;
  serviceAccess?: string;
  slackIdentityState?: string;
  accessEndingDays?: number;
  dateJoinedFrom?: string;
  dateJoinedTo?: string;
  cancellationFrom?: string;
  cancellationTo?: string;
  actionableOnly?: boolean;
  informationalOnly?: boolean;
  stripeConflict?: boolean;
  duplicateStripe?: boolean;
  missingStripeId?: boolean;
  missingSlack?: boolean;
  slackIdentityUnresolved?: boolean;
  missingCityChannel?: boolean;
  missingAllMembers?: boolean;
  expiredStillInSlack?: boolean;
  gracePeriod?: boolean;
};

export type FilterOptions = {
  cities: string[];
  memberships: string[];
  payments: string[];
  issueCodes: string[];
  slackIdentityStates: string[];
};

export function MemberFilterDrawer(props: {
  open: boolean;
  onClose: () => void;
  value: MemberFilterState;
  options: FilterOptions;
  onApply: (next: MemberFilterState) => void;
}) {
  const [draft, setDraft] = useState<MemberFilterState>(props.value);

  useEffect(() => {
    if (props.open) setDraft(props.value);
  }, [props.open, props.value]);

  const set = <K extends keyof MemberFilterState>(key: K, v: MemberFilterState[K]) => {
    setDraft((d) => ({ ...d, [key]: v }));
  };

  return (
    <Drawer
      title="Directory filters"
      open={props.open}
      onClose={props.onClose}
      size={400}
      extra={
        <Space>
          <Button onClick={() => setDraft({})}>Reset</Button>
          <Button
            type="primary"
            onClick={() => {
              props.onApply(draft);
              props.onClose();
            }}
          >
            Apply
          </Button>
        </Space>
      }
    >
      <Typography.Text strong>Member information</Typography.Text>
      <Space orientation="vertical" style={{ width: "100%", marginTop: 8, marginBottom: 16 }}>
        <Select
          allowClear
          showSearch
          placeholder="City"
          style={{ width: "100%" }}
          value={draft.city || undefined}
          onChange={(v) => set("city", v || undefined)}
          options={props.options.cities.map((c) => ({ value: c, label: c }))}
        />
        <Select
          allowClear
          placeholder="Membership"
          style={{ width: "100%" }}
          value={draft.membership || undefined}
          onChange={(v) => set("membership", v || undefined)}
          options={props.options.memberships.map((c) => ({ value: c, label: c }))}
        />
        <Select
          allowClear
          placeholder="Payment"
          style={{ width: "100%" }}
          value={draft.payment || undefined}
          onChange={(v) => set("payment", v || undefined)}
          options={props.options.payments.map((c) => ({ value: c, label: c }))}
        />
        <Typography.Text type="secondary">Date joined (from / to ISO)</Typography.Text>
        <Space.Compact style={{ width: "100%" }}>
          <DatePicker
            style={{ width: "50%" }}
            placeholder="From"
            onChange={(_, s) =>
              set("dateJoinedFrom", typeof s === "string" && s ? s : undefined)
            }
          />
          <DatePicker
            style={{ width: "50%" }}
            placeholder="To"
            onChange={(_, s) =>
              set("dateJoinedTo", typeof s === "string" && s ? s : undefined)
            }
          />
        </Space.Compact>
        <Typography.Text type="secondary">Cancellation date (from / to ISO)</Typography.Text>
        <Space.Compact style={{ width: "100%" }}>
          <DatePicker
            style={{ width: "50%" }}
            placeholder="From"
            onChange={(_, s) =>
              set("cancellationFrom", typeof s === "string" && s ? s : undefined)
            }
          />
          <DatePicker
            style={{ width: "50%" }}
            placeholder="To"
            onChange={(_, s) =>
              set("cancellationTo", typeof s === "string" && s ? s : undefined)
            }
          />
        </Space.Compact>
      </Space>

      <Divider />
      <Typography.Text strong>Access</Typography.Text>
      <Space orientation="vertical" style={{ width: "100%", marginTop: 8, marginBottom: 16 }}>
        <Select
          allowClear
          placeholder="Access state"
          style={{ width: "100%" }}
          value={draft.serviceAccess || undefined}
          onChange={(v) => set("serviceAccess", v || undefined)}
          options={[
            { value: "current", label: "Current access" },
            { value: "grace", label: "Grace-period access" },
            { value: "expired", label: "Expired access" },
            { value: "invalid_date", label: "Invalid access date" },
          ]}
        />
        <Typography.Text type="secondary">Access ending within (days)</Typography.Text>
        <InputNumber
          min={1}
          max={90}
          style={{ width: "100%" }}
          value={draft.accessEndingDays}
          onChange={(v) => set("accessEndingDays", typeof v === "number" ? v : undefined)}
        />
        <Checkbox
          checked={Boolean(draft.gracePeriod)}
          onChange={(e) => set("gracePeriod", e.target.checked || undefined)}
        >
          Cancelled but still in grace period
        </Checkbox>
      </Space>

      <Divider />
      <Typography.Text strong>Stripe</Typography.Text>
      <Space orientation="vertical" style={{ width: "100%", marginTop: 8, marginBottom: 16 }}>
        <Checkbox
          checked={Boolean(draft.missingStripeId)}
          onChange={(e) => set("missingStripeId", e.target.checked || undefined)}
        >
          Stripe ID missing
        </Checkbox>
        <Checkbox
          checked={Boolean(draft.stripeConflict)}
          onChange={(e) => set("stripeConflict", e.target.checked || undefined)}
        >
          Stripe conflict
        </Checkbox>
        <Checkbox
          checked={Boolean(draft.duplicateStripe)}
          onChange={(e) => set("duplicateStripe", e.target.checked || undefined)}
        >
          Duplicate Stripe assignment
        </Checkbox>
      </Space>

      <Divider />
      <Typography.Text strong>Slack</Typography.Text>
      <Space orientation="vertical" style={{ width: "100%", marginTop: 8, marginBottom: 16 }}>
        <Select
          allowClear
          placeholder="Slack identity state"
          style={{ width: "100%" }}
          value={draft.slackIdentityState || undefined}
          onChange={(v) => set("slackIdentityState", v || undefined)}
          options={props.options.slackIdentityStates.map((s) => ({
            value: s,
            label: s.replace(/_/g, " "),
          }))}
        />
        <Checkbox
          checked={Boolean(draft.missingSlack)}
          onChange={(e) => set("missingSlack", e.target.checked || undefined)}
        >
          Missing Slack
        </Checkbox>
        <Checkbox
          checked={Boolean(draft.slackIdentityUnresolved)}
          onChange={(e) => set("slackIdentityUnresolved", e.target.checked || undefined)}
        >
          Slack identity unresolved
        </Checkbox>
        <Checkbox
          checked={Boolean(draft.missingCityChannel)}
          onChange={(e) => set("missingCityChannel", e.target.checked || undefined)}
        >
          Missing city channel
        </Checkbox>
        <Checkbox
          checked={Boolean(draft.missingAllMembers)}
          onChange={(e) => set("missingAllMembers", e.target.checked || undefined)}
        >
          Missing all-members channel
        </Checkbox>
        <Checkbox
          checked={Boolean(draft.expiredStillInSlack)}
          onChange={(e) => set("expiredStillInSlack", e.target.checked || undefined)}
        >
          Expired member still in Slack
        </Checkbox>
      </Space>

      <Divider />
      <Typography.Text strong>Issues</Typography.Text>
      <Space orientation="vertical" style={{ width: "100%", marginTop: 8 }}>
        <Select
          allowClear
          placeholder="Severity"
          style={{ width: "100%" }}
          value={draft.severity || undefined}
          onChange={(v) => set("severity", v || undefined)}
          options={[
            { value: "critical", label: "Critical" },
            { value: "high", label: "High" },
            { value: "medium", label: "Medium" },
            { value: "info", label: "Informational" },
          ]}
        />
        <Select
          allowClear
          showSearch
          placeholder="Issue code"
          style={{ width: "100%" }}
          value={draft.issueCode || undefined}
          onChange={(v) => set("issueCode", v || undefined)}
          options={props.options.issueCodes.map((c) => ({ value: c, label: c }))}
        />
        <Checkbox
          checked={Boolean(draft.actionableOnly)}
          onChange={(e) => set("actionableOnly", e.target.checked || undefined)}
        >
          Actionable only
        </Checkbox>
        <Checkbox
          checked={Boolean(draft.informationalOnly)}
          onChange={(e) => set("informationalOnly", e.target.checked || undefined)}
        >
          Informational only
        </Checkbox>
      </Space>
    </Drawer>
  );
}
