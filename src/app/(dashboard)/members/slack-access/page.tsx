"use client";

import { useCallback, useEffect, useMemo, useRef, useState, Suspense } from "react";
import {
  App,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Input,
  Modal,
  Select,
  Skeleton,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { OpsPageHeader } from "@/components/ops/OpsPageHeader";
import { ErrorState } from "@/components/ops/ErrorState";
import { MemberDetailsDrawer } from "@/components/ops/MemberDetailsDrawer";
import { SlackUserChannelsCell } from "@/components/ops/SlackUserChannelsCell";
import { ServiceAccessStateTag } from "@/components/ops/ServiceAccessStateTag";
import { RemovalReadinessTag } from "@/components/ops/RemovalReadinessTag";
import type { MemberHealthRow } from "@/lib/ops/member-health-types";
import type { ChannelHealthRow } from "@/lib/ops/channel-membership";

type WorkspaceUser = {
  slackUserId: string;
  name: string;
  email: string;
  airtableMatch: string;
  memberName: string;
  city: string;
  serviceAccessUntil: string;
  serviceAccessState: string;
  channels: Array<{ id: string; name: string; membership: string }>;
  channelCount: number;
  recommendedAction: string;
  airtableRecordId: string;
};

type RemovalRow = {
  member: MemberHealthRow;
  daysExpired: number | null;
  readiness: string;
  currentChannels: string[];
  lastRemovalAttempt: string | null;
  lastRemovalStatus: string | null;
};

type EmailPreview = {
  recipient: string;
  subject: string;
  html: string;
  text: string;
  eligible: boolean;
  eligibilityReasons: string[];
  missingConfig: string[];
};

const previewCache = new Map<
  string,
  { at: number; preview: EmailPreview; scanVersion: string }
>();
const PREVIEW_TTL_MS = 60_000;

function SlackAccessPageInner() {
  const { message, modal } = App.useApp();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") || "needs";

  const [mode, setMode] = useState("read_only");
  const [role, setRole] = useState("viewer");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needs, setNeeds] = useState<MemberHealthRow[]>([]);
  const [channels, setChannels] = useState<ChannelHealthRow[]>([]);
  const [workspaceUsers, setWorkspaceUsers] = useState<WorkspaceUser[]>([]);
  const [userFilter, setUserFilter] = useState("");
  const [channelFilter, setChannelFilter] = useState<string | undefined>();
  const [expiredOnly, setExpiredOnly] = useState(false);
  const [noMatchOnly, setNoMatchOnly] = useState(false);
  const [noChannelOnly, setNoChannelOnly] = useState(false);
  const [removalRows, setRemovalRows] = useState<RemovalRow[]>([]);
  const [capabilities, setCapabilities] = useState<{
    canKickFromChannels: boolean;
    canDeactivateWorkspaceUser: boolean;
    deactivateReason: string;
  } | null>(null);
  const [selectedMember, setSelectedMember] = useState<MemberHealthRow | null>(null);
  const [channelDetail, setChannelDetail] = useState<ChannelHealthRow | null>(null);

  // Email preview
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [previewMemberId, setPreviewMemberId] = useState<string | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  const previewInflight = useRef<string | null>(null);

  const [selectedRemoval, setSelectedRemoval] = useState<Set<string>>(new Set());

  const canMutate = mode === "live" && role === "admin";

  const setTab = (t: string) => {
    const p = new URLSearchParams(searchParams.toString());
    p.set("tab", t);
    router.replace(`${pathname}?${p.toString()}`);
  };

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/ops-dashboard/config");
      const json = await res.json();
      if (json.mode) setMode(json.mode);
      if (json.role) setRole(json.role);
    } catch {
      /* ignore */
    }
  }, []);

  const loadNeeds = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        "/api/ops-dashboard/members?missingSlack=1&serviceAccess=current&pageSize=200&page=1"
      );
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || res.statusText);
      setNeeds(json.members || []);
      setMode(json.summary?.mode || mode);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [mode]);

  const loadChannels = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ops-dashboard/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activeOnlyFetch: true }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || res.statusText);
      setChannels(json.channels || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadWorkspaceUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ pageSize: "200", page: "1" });
      if (userFilter) p.set("q", userFilter);
      if (channelFilter) p.set("channelId", channelFilter);
      if (expiredOnly) p.set("expiredOnly", "1");
      if (noMatchOnly) p.set("noAirtableMatch", "1");
      if (noChannelOnly) p.set("noConfiguredChannel", "1");
      const res = await fetch(`/api/ops-dashboard/slack/workspace-users?${p}`);
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || res.statusText);
      setWorkspaceUsers(json.users || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [userFilter, channelFilter, expiredOnly, noMatchOnly, noChannelOnly]);

  const loadRemoval = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ops-dashboard/slack/removal-queue");
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || res.statusText);
      setRemovalRows(json.rows || []);
      setCapabilities(json.capabilities || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
  }, [loadConfig]);

  useEffect(() => {
    if (tab === "needs") void loadNeeds();
    if (tab === "channels") void loadChannels();
    if (tab === "users") void loadWorkspaceUsers();
    if (tab === "removal") void loadRemoval();
  }, [tab, loadNeeds, loadChannels, loadWorkspaceUsers, loadRemoval]);

  const openPreview = async (id: string) => {
    if (previewInflight.current === id) return;
    setPreviewMemberId(id);
    setPreviewOpen(true);
    setPreview(null);
    setPreviewLoading(true);

    const cached = previewCache.get(id);
    if (cached && Date.now() - cached.at < PREVIEW_TTL_MS) {
      setPreview(cached.preview);
      setPreviewLoading(false);
      return;
    }

    previewAbort.current?.abort();
    const ac = new AbortController();
    previewAbort.current = ac;
    previewInflight.current = id;

    try {
      const res = await fetch("/api/ops-dashboard/slack-email/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ airtableRecordId: id }),
        signal: ac.signal,
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        message.error(json.message || "Preview failed");
        return;
      }
      setPreview(json.preview);
      previewCache.set(id, {
        at: Date.now(),
        preview: json.preview,
        scanVersion: json.scanVersion || "",
      });
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") return;
      message.error(e instanceof Error ? e.message : "Preview failed");
    } finally {
      if (previewInflight.current === id) previewInflight.current = null;
      setPreviewLoading(false);
    }
  };

  const closePreview = () => {
    previewAbort.current?.abort();
    setPreviewOpen(false);
    setPreview(null);
    setPreviewMemberId(null);
    setPreviewLoading(false);
  };

  const sendEmail = async () => {
    if (!previewMemberId) return;
    if (!canMutate) {
      message.warning("Sending requires LIVE mode and admin role");
      return;
    }
    const res = await fetch("/api/ops-dashboard/slack-email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ airtableRecordId: previewMemberId }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      message.error(json.message || "Send failed");
      return;
    }
    const r = json.results?.[0];
    if (r?.status === "sent") message.success("Email accepted by Resend");
    else message.warning(`${r?.status}: ${r?.error || ""}`);
    closePreview();
    loadNeeds();
  };

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      message.success(`${label} copied`);
    } catch {
      message.error(`Could not copy ${label.toLowerCase()}`);
    }
  };

  const allMembersChannel = useMemo(
    () => channels.find((c) => c.isAllMembersChannel) || null,
    [channels]
  );

  const runRemoval = async (ids: string[], action: string) => {
    if (!canMutate) {
      message.warning("Removal requires LIVE mode and admin role");
      return;
    }
    modal.confirm({
      title: `Confirm ${action} for ${ids.length} member(s)?`,
      content:
        "Server will revalidate Service access until before any action. Members with valid access will be skipped.",
      onOk: async () => {
        const res = await fetch("/api/ops-dashboard/slack/removal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: action === "preview" ? "preview" : "remove_channels",
            airtableRecordIds: ids,
          }),
        });
        const json = await res.json();
        if (!res.ok || json.success === false) {
          message.error(json.message || "Action failed");
          return;
        }
        if (action === "preview") {
          message.info(`Plans ready for ${json.plans?.length || 0} member(s)`);
          console.info(json.plans);
        } else {
          message.success("Removal request completed (see per-member results)");
        }
        loadRemoval();
      },
    });
  };

  const selectedEmails = removalRows
    .filter((r) => r.member.airtableRecordId && selectedRemoval.has(r.member.airtableRecordId))
    .map((r) => r.member.primaryEmail)
    .filter(Boolean);

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <OpsPageHeader
        title="Slack Access"
        description="Identities, channel membership, workspace users, joining emails, and expired-access removal queue."
        breadcrumbs={[
          { title: "Members", href: "/members" },
          { title: "Slack Access" },
        ]}
        mode={mode}
        onRefresh={() => {
          if (tab === "needs") void loadNeeds();
          if (tab === "channels") void loadChannels();
          if (tab === "users") void loadWorkspaceUsers();
          if (tab === "removal") void loadRemoval();
        }}
        refreshing={loading}
      />

      {error && (
        <ErrorState
          message={error}
          onRetry={() => {
            if (tab === "needs") void loadNeeds();
            if (tab === "channels") void loadChannels();
            if (tab === "users") void loadWorkspaceUsers();
            if (tab === "removal") void loadRemoval();
          }}
        />
      )}

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "needs",
            label: "Needs Slack",
            children: (
              <Table
                size="small"
                loading={loading}
                rowKey={(r) => r.airtableRecordId || r.primaryEmail}
                dataSource={needs}
                onRow={(r) => ({
                  onClick: () => setSelectedMember(r),
                  style: { cursor: "pointer" },
                })}
                columns={[
                  { title: "Name", dataIndex: "name" },
                  { title: "Email", dataIndex: "primaryEmail" },
                  { title: "City", dataIndex: "city" },
                  {
                    title: "Action",
                    render: (_, r) => (
                      <Button
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation();
                          if (r.airtableRecordId) void openPreview(r.airtableRecordId);
                        }}
                      >
                        Preview email
                      </Button>
                    ),
                  },
                ]}
              />
            ),
          },
          {
            key: "channels",
            label: "Channels",
            children: (
              <>
                {allMembersChannel?.allMembersBreakdown && (
                  <Card size="small" title="all-wlth-wlks actual membership" style={{ marginBottom: 16 }}>
                    <Descriptions size="small" column={2}>
                      <Descriptions.Item label="Active humans present">
                        {allMembersChannel.allMembersBreakdown.activeHumansIncluded}
                      </Descriptions.Item>
                      <Descriptions.Item label="Raw channel member IDs">
                        {allMembersChannel.allMembersBreakdown.rawChannelMemberIds}
                      </Descriptions.Item>
                      <Descriptions.Item label="Deleted/deactivated excluded">
                        {allMembersChannel.allMembersBreakdown.deletedExcluded}
                      </Descriptions.Item>
                      <Descriptions.Item label="Bots/apps excluded">
                        {allMembersChannel.allMembersBreakdown.botsAppsExcluded}
                      </Descriptions.Item>
                      <Descriptions.Item label="IDs not in users.list">
                        {allMembersChannel.allMembersBreakdown.idsNotInUsersList}
                      </Descriptions.Item>
                      <Descriptions.Item label="Current access present">
                        {allMembersChannel.allMembersBreakdown.currentAccessPresent}
                      </Descriptions.Item>
                      <Descriptions.Item label="Grace period present">
                        {allMembersChannel.allMembersBreakdown.gracePeriodPresent}
                      </Descriptions.Item>
                      <Descriptions.Item label="Expired present">
                        {allMembersChannel.allMembersBreakdown.expiredPresent}
                      </Descriptions.Item>
                      <Descriptions.Item label="Unmatched Slack users">
                        {allMembersChannel.allMembersBreakdown.unmatchedSlackUsers}
                      </Descriptions.Item>
                      <Descriptions.Item label="Expected current-access missing">
                        {allMembersChannel.allMembersBreakdown.expectedCurrentAccessMissing}
                      </Descriptions.Item>
                    </Descriptions>
                  </Card>
                )}
                <Table
                  size="small"
                  loading={loading}
                  rowKey={(r) => r.key}
                  dataSource={channels}
                  onRow={(r) => ({
                    onClick: () => setChannelDetail(r),
                    style: { cursor: "pointer" },
                  })}
                  columns={[
                    {
                      title: "Channel",
                      render: (_, r) => (
                        <span>
                          {r.channelName}{" "}
                          {r.isAllMembersChannel && <Tag color="purple">all-members</Tag>}
                        </span>
                      ),
                    },
                    {
                      title: "Present",
                      dataIndex: "presentCount",
                      render: (v, r) =>
                        r.isAllMembersChannel
                          ? r.allMembersBreakdown?.activeHumansIncluded ?? v
                          : v,
                    },
                    { title: "Missing", dataIndex: "missingCount" },
                    { title: "Unresolved", dataIndex: "unresolvedCount" },
                    {
                      title: "Status",
                      dataIndex: "scanStatus",
                      render: (v: string) => <Tag>{v}</Tag>,
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "users",
            label: "Workspace Users",
            children: (
              <>
                <Space wrap style={{ marginBottom: 12 }}>
                  <Input.Search
                    placeholder="Search name/email/Slack ID"
                    allowClear
                    onSearch={setUserFilter}
                    style={{ width: 260 }}
                  />
                  <Select
                    allowClear
                    placeholder="Filter by channel"
                    style={{ width: 220 }}
                    value={channelFilter}
                    onChange={setChannelFilter}
                    options={channels
                      .filter((c) => c.slackChannelId)
                      .map((c) => ({
                        value: c.slackChannelId,
                        label: c.channelName,
                      }))}
                  />
                  <Checkbox checked={expiredOnly} onChange={(e) => setExpiredOnly(e.target.checked)}>
                    Expired member
                  </Checkbox>
                  <Checkbox checked={noMatchOnly} onChange={(e) => setNoMatchOnly(e.target.checked)}>
                    No Airtable match
                  </Checkbox>
                  <Checkbox
                    checked={noChannelOnly}
                    onChange={(e) => setNoChannelOnly(e.target.checked)}
                  >
                    No configured channel
                  </Checkbox>
                  <Button onClick={() => void loadWorkspaceUsers()}>Apply</Button>
                </Space>
                <Table
                  size="small"
                  loading={loading}
                  rowKey={(r) => r.slackUserId}
                  dataSource={workspaceUsers}
                  scroll={{ x: 1200 }}
                  columns={[
                    { title: "Name", dataIndex: "name", width: 140 },
                    { title: "Email", dataIndex: "email", width: 200 },
                    { title: "Slack ID", dataIndex: "slackUserId", width: 120 },
                    {
                      title: "Airtable",
                      dataIndex: "airtableMatch",
                      width: 100,
                      render: (v: string) => <Tag>{v}</Tag>,
                    },
                    {
                      title: "Access",
                      dataIndex: "serviceAccessState",
                      width: 110,
                      render: (v: string) => <ServiceAccessStateTag state={v} />,
                    },
                    {
                      title: "Until",
                      dataIndex: "serviceAccessUntil",
                      width: 110,
                      render: (v: string) => v || "—",
                    },
                    { title: "City", dataIndex: "city", width: 100 },
                    {
                      title: "Channels",
                      width: 220,
                      render: (_, r) => <SlackUserChannelsCell channels={r.channels} />,
                    },
                    { title: "#", dataIndex: "channelCount", width: 50 },
                    {
                      title: "Action",
                      dataIndex: "recommendedAction",
                      ellipsis: true,
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "removal",
            label: "Expired Access / Removal Queue",
            children: (
              <>
                <Space wrap style={{ marginBottom: 12 }}>
                  <Button
                    onClick={() =>
                      void runRemoval([...selectedRemoval], "preview")
                    }
                    disabled={!selectedRemoval.size}
                  >
                    Preview removal plan
                  </Button>
                  <Button
                    onClick={async () => {
                      await copyText(selectedEmails.join("\n"), "Emails");
                    }}
                    disabled={!selectedEmails.length}
                  >
                    Copy selected emails
                  </Button>
                  <Button
                    onClick={() => {
                      const lines = [
                        "email,name,city,serviceAccessUntil,readiness",
                        ...removalRows
                          .filter(
                            (r) =>
                              r.member.airtableRecordId &&
                              selectedRemoval.has(r.member.airtableRecordId)
                          )
                          .map((r) =>
                            [
                              r.member.primaryEmail,
                              r.member.name,
                              r.member.city,
                              r.member.serviceAccessUntil,
                              r.readiness,
                            ]
                              .map((v) => `"${String(v).replace(/"/g, '""')}"`)
                              .join(",")
                          ),
                      ];
                      const blob = new Blob([lines.join("\n")], { type: "text/csv" });
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(blob);
                      a.download = "removal-queue.csv";
                      a.click();
                      message.success("CSV exported");
                    }}
                    disabled={!selectedRemoval.size}
                  >
                    Export selected CSV
                  </Button>
                  <Button
                    href="https://wlthwlks.slack.com/admin"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Slack Admin
                  </Button>
                  <Button
                    danger
                    disabled={
                      !canMutate ||
                      !selectedRemoval.size ||
                      !capabilities?.canKickFromChannels
                    }
                    onClick={() => void runRemoval([...selectedRemoval], "remove")}
                  >
                    Remove from WLTH channels
                  </Button>
                  <Button
                    danger
                    disabled
                    title={
                      capabilities?.deactivateReason ||
                      "Workspace deactivation unavailable"
                    }
                  >
                    Deactivate account (unavailable)
                  </Button>
                </Space>
                {capabilities && !capabilities.canDeactivateWorkspaceUser && (
                  <Typography.Paragraph type="secondary">
                    {capabilities.deactivateReason}
                  </Typography.Paragraph>
                )}
                {!capabilities?.canKickFromChannels && (
                  <Typography.Paragraph type="secondary">
                    Channel kick unavailable — bot needs channels:write / groups:write and
                    must be in target channels. Use CSV + Slack Admin as fallback.
                  </Typography.Paragraph>
                )}
                <Table
                  size="small"
                  loading={loading}
                  rowKey={(r) => r.member.airtableRecordId || r.member.primaryEmail}
                  dataSource={removalRows}
                  rowSelection={{
                    selectedRowKeys: [...selectedRemoval],
                    onChange: (keys) => setSelectedRemoval(new Set(keys.map(String))),
                    getCheckboxProps: (r) => ({
                      disabled: r.readiness === "still_has_access",
                    }),
                  }}
                  onRow={(r) => ({
                    onClick: () => setSelectedMember(r.member),
                    style: { cursor: "pointer" },
                  })}
                  scroll={{ x: 1400 }}
                  columns={[
                    { title: "Member", render: (_, r) => r.member.name },
                    { title: "Email", render: (_, r) => r.member.primaryEmail },
                    { title: "City", render: (_, r) => r.member.city },
                    { title: "Membership", render: (_, r) => r.member.membership },
                    { title: "Payment", render: (_, r) => r.member.payment },
                    {
                      title: "Cancellation",
                      render: (_, r) => r.member.cancellationDate || "—",
                    },
                    {
                      title: "Access until",
                      render: (_, r) => r.member.serviceAccessUntil || "—",
                    },
                    {
                      title: "Days expired",
                      render: (_, r) => r.daysExpired ?? "—",
                    },
                    {
                      title: "Slack",
                      render: (_, r) => r.member.slackIdentityState.replace(/_/g, " "),
                    },
                    {
                      title: "Channels",
                      render: (_, r) => r.currentChannels.join(", ") || "—",
                    },
                    {
                      title: "all-wlth-wlks",
                      render: (_, r) => r.member.allMembersChannelMembership,
                    },
                    {
                      title: "City channel",
                      render: (_, r) => r.member.cityChannelMembership,
                    },
                    {
                      title: "Readiness",
                      render: (_, r) => <RemovalReadinessTag readiness={r.readiness} />,
                    },
                    {
                      title: "Last attempt",
                      render: (_, r) =>
                        r.lastRemovalAttempt
                          ? `${r.lastRemovalStatus} @ ${r.lastRemovalAttempt}`
                          : "—",
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "config",
            label: "Config",
            children: (
              <Card size="small">
                <Typography.Paragraph>
                  Required: SLACK_BOT_TOKEN, SLACK_ALL_MEMBERS_CHANNEL_ID,
                  SLACK_WORKSPACE_INVITE_URL, users:read, users:read.email, channels:read,
                  groups:read. Channel kick needs channels:write / groups:write. Workspace
                  deactivation needs admin.users:write (Enterprise Grid) — not available on
                  ordinary bot tokens.
                </Typography.Paragraph>
                <Typography.Paragraph type="secondary">
                  Private channels require inviting the bot. Invisible channels are marked
                  not checked — never shown as no access.
                </Typography.Paragraph>
              </Card>
            ),
          },
        ]}
      />

      <Modal
        open={previewOpen}
        onCancel={closePreview}
        title="Slack joining email preview"
        width={640}
        okText="Send"
        okButtonProps={{ disabled: !canMutate || previewLoading || !preview?.eligible }}
        onOk={() => void sendEmail()}
        destroyOnHidden
      >
        {previewLoading && <Skeleton active paragraph={{ rows: 8 }} />}
        {!previewLoading && preview && (
          <div>
            <Typography.Text type="secondary">To: {preview.recipient}</Typography.Text>
            <div style={{ margin: "8px 0" }}>
              <strong>{preview.subject}</strong>
            </div>
            {!preview.eligible && (
              <Typography.Paragraph type="danger">
                Not eligible: {preview.eligibilityReasons.join("; ")}
              </Typography.Paragraph>
            )}
            <div
              style={{
                border: "1px solid #eee",
                borderRadius: 8,
                padding: 12,
                maxHeight: 360,
                overflow: "auto",
              }}
              dangerouslySetInnerHTML={{ __html: preview.html }}
            />
          </div>
        )}
      </Modal>

      <Drawer
        open={Boolean(channelDetail)}
        onClose={() => setChannelDetail(null)}
        size="large"
        title={channelDetail?.channelName || "Channel"}
      >
        {channelDetail && (
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Slack Channel ID">
              {channelDetail.slackChannelId || "—"}
            </Descriptions.Item>
            <Descriptions.Item label="Present">{channelDetail.presentCount}</Descriptions.Item>
            <Descriptions.Item label="Missing">{channelDetail.missingCount}</Descriptions.Item>
            <Descriptions.Item label="Scan">{channelDetail.scanStatus}</Descriptions.Item>
            {channelDetail.scanError && (
              <Descriptions.Item label="Error">{channelDetail.scanError}</Descriptions.Item>
            )}
          </Descriptions>
        )}
      </Drawer>

      <MemberDetailsDrawer
        open={Boolean(selectedMember)}
        member={selectedMember}
        onClose={() => setSelectedMember(null)}
      />
    </div>
  );
}

export default function SlackAccessPage() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: 48, textAlign: "center" }}>
          <Spin size="large" />
        </div>
      }
    >
      <SlackAccessPageInner />
    </Suspense>
  );
}
