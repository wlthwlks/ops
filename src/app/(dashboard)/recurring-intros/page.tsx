"use client";

import { useState, useCallback, useEffect } from "react";
import {
  Alert,
  Button,
  Card,
  Collapse,
  DatePicker,
  Divider,
  Empty,
  Flex,
  Input,
  Modal,
  Select,
  Spin,
  Table,
  Tag,
  Typography,
  Space,
  Switch,
  Badge,
  Tabs,
  Checkbox,
  App,
} from "antd";
import {
  WarningOutlined,
  SendOutlined,
  EyeOutlined,
  SwapOutlined,
  CalendarOutlined,
  UserDeleteOutlined,
  MailOutlined,
  CheckOutlined,
  ScanOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";

const { Title, Text, Paragraph } = Typography;

interface GroupPreview {
  members: Array<{ name: string; email: string; slackUserId: string | null }>;
  unmatched: boolean;
}

interface ChannelPreview {
  channelName: string;
  cityName: string;
  cycleId: string;
  config: {
    groupSize: number;
    strictGroupSize: boolean;
    introFrequencyWeeks: number;
    introLocalTime: string;
    timezone: string;
    googleCalendarEnabled: boolean;
    outlookEnabled: boolean;
    meetingDurationMinutes: number;
    autoScheduleMeeting: boolean;
  };
  slackUserCount: number;
  eligibleMembers: Array<{ name: string; email: string }>;
  proposedGroups: GroupPreview[];
  groupSizes: number[];
  unmatchedMembers: Array<{ name: string; email: string }>;
  excludedByReason: Record<string, Array<{ name: string; email: string }>>;
  membersNotFoundInAirtable: string[];
  airtableMembersNotOnSlack: string[];
  recentRepeatWarnings: string[];
  calendarWarning: string | null;
  renderedMessages: string[];
  isDue: boolean;
  channelMembershipError: string | null;
}

interface PreviewResult {
  success: boolean;
  summary: string;
  previews: ChannelPreview[];
  sentGroups: number;
  failedGroups: number;
  skippedChannels?: Array<{ name: string; reason: string }>;
  mode?: "read_only" | "live";
  readOnly?: boolean;
  sendable?: boolean;
  planId?: string | null;
  requestId?: string;
  proposedGroupCount?: number;
}

interface IntroConfig {
  mode: "read_only" | "live";
  readOnly: boolean;
  live: boolean;
  sendEnabled: boolean;
  writesEnabled: boolean;
  slackDeliveryEnabled: boolean;
  airtableWritesEnabled: boolean;
  postgresWritesEnabled: boolean;
  pineconeWritesEnabled: boolean;
  automationWillSend: boolean;
  ledgerAvailable: boolean;
  allowedChannelCount: number;
  memberCooldownDays: number;
  pairCooldownDays: number;
  onboardingCooldownDays: number;
  planTtlMinutes: number;
}

export default function RecurringIntrosPage() {
  const { message } = App.useApp();
  const [dueOnly, setDueOnly] = useState(true);
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [cycleDate, setCycleDate] = useState<Dayjs | null>(dayjs());
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sendLoading, setSendLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null);
  const [sendResult, setSendResult] = useState<PreviewResult | null>(null);
  const [confirmVisible, setConfirmVisible] = useState(false);
  const [introConfig, setIntroConfig] = useState<IntroConfig | null>(null);

  // ── Email Resolver state ──
  interface Suggestion {
    airtableRecordId: string;
    name: string;
    airtableEmail: string;
    suggestedSlackEmail: string;
    suggestedSlackName: string;
    slackUserId: string;
    confidence: "high" | "low";
    city: string;
  }
  interface SkippedEntry {
    airtableRecordId: string;
    name: string;
    airtableEmail: string;
    city: string;
    reason: string;
    detail: string;
  }
  const [scanLoading, setScanLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [skippedMembers, setSkippedMembers] = useState<SkippedEntry[]>([]);
  const [skippedByReason, setSkippedByReason] = useState<Record<string, number>>({});
  const [scanSummary, setScanSummary] = useState<string | null>(null);
  const [scanMemberCount, setScanMemberCount] = useState(0);
  const [scanSlackUserCount, setScanSlackUserCount] = useState(0);
  const [slackWithEmail, setSlackWithEmail] = useState(0);
  const [slackWithoutEmail, setSlackWithoutEmail] = useState(0);
  const [selectedSuggestions, setSelectedSuggestions] = useState<Set<string>>(new Set());
  const [writeLoading, setWriteLoading] = useState(false);
  const [writeResult, setWriteResult] = useState<{ written: number; failed: number; errors: string[] } | null>(null);
  const [writeConfirmVisible, setWriteConfirmVisible] = useState(false);
  const [emailResolveError, setEmailResolveError] = useState<string | null>(null);
  const [emailCityFilter, setEmailCityFilter] = useState<string | null>(null);
  const [verboseMode, setVerboseMode] = useState(false);
  const [verboseUsers, setVerboseUsers] = useState<Array<{ name: string; email: string; slackId: string }>>([]);
  const [verboseSearch, setVerboseSearch] = useState("");
  const [slackTotalCount, setSlackTotalCount] = useState(0);

  // ── Slack Users tab state ──
  interface SlackUserRow {
    slackId: string;
    name: string;
    email: string;
    deleted: boolean;
    isBot: boolean;
    isAppUser: boolean;
  }
  const [slackUsersList, setSlackUsersList] = useState<SlackUserRow[]>([]);
  const [slackUsersLoading, setSlackUsersLoading] = useState(false);
  const [slackUsersSummary, setSlackUsersSummary] = useState<string | null>(null);
  const [slackUsersSearch, setSlackUsersSearch] = useState("");
  const [slackUsersStatusFilter, setSlackUsersStatusFilter] = useState<string | null>(null);
  const [slackUsersEmailFilter, setSlackUsersEmailFilter] = useState<string | null>(null);
  const [slackDeletedCount, setSlackDeletedCount] = useState(0);
  const [slackBotCount, setSlackBotCount] = useState(0);
  const [slackAppUserCount, setSlackAppUserCount] = useState(0);
  const [slackActiveCount, setSlackActiveCount] = useState(0);
  const [authScopes, setAuthScopes] = useState<string[]>([]);
  const [authTeam, setAuthTeam] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);

  const readOnly = introConfig?.readOnly !== false; // default read-only until config loads
  const sendEnabled = introConfig?.sendEnabled === true;

  useEffect(() => {
    fetch("/api/recurring-intros/config")
      .then((r) => r.json())
      .then((data) => {
        if (data.mode) setIntroConfig(data as IntroConfig);
      })
      .catch(() => {
        setIntroConfig({
          mode: "read_only",
          readOnly: true,
          live: false,
          sendEnabled: false,
          writesEnabled: false,
          slackDeliveryEnabled: false,
          airtableWritesEnabled: false,
          postgresWritesEnabled: false,
          pineconeWritesEnabled: false,
          automationWillSend: false,
          ledgerAvailable: false,
          allowedChannelCount: 0,
          memberCooldownDays: 14,
          pairCooldownDays: 60,
          onboardingCooldownDays: 14,
          planTtlMinutes: 30,
        });
      });
  }, []);

  const clearPreview = useCallback(() => {
    setPreviewResult(null);
    setSendResult(null);
  }, []);

  const handlePreview = useCallback(async () => {
    setPreviewLoading(true);
    setPreviewResult(null);
    setSendResult(null);
    try {
      const res = await fetch("/api/recurring-intros/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channelRecordIds: selectedChannels.length > 0 ? selectedChannels : undefined,
          cycleDate: cycleDate?.format("YYYY-MM-DD"),
          dueOnly,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        message.error(data.message || data.error || data.summary || "Preview failed");
      } else {
        message.info(
          data.readOnly
            ? "Real-data read-only preview generated. Nothing was saved or sent."
            : data.summary || "Preview ready"
        );
      }
      setPreviewResult(data);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Preview failed");
      setPreviewResult({
        success: false,
        summary: err instanceof Error ? err.message : "Preview failed",
        previews: [],
        sentGroups: 0,
        failedGroups: 0,
      });
    } finally {
      setPreviewLoading(false);
    }
  }, [selectedChannels, cycleDate, dueOnly, message]);

  const handleSend = useCallback(async () => {
    if (!previewResult || readOnly) return;
    setSendLoading(true);
    try {
      const res = await fetch("/api/recurring-intros/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          channelRecordIds: selectedChannels.length > 0 ? selectedChannels : undefined,
          cycleDate: cycleDate?.format("YYYY-MM-DD"),
        }),
      });
      const data = await res.json();
      setSendResult(data);
      if (res.status === 207) {
        message.warning(data.summary || "Partial success");
      } else if (!res.ok || data.success === false) {
        message.error(data.message || data.error || data.summary || "Send failed");
      } else {
        message.success(data.summary || "Introductions sent");
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Send failed");
      setSendResult({
        success: false,
        summary: err instanceof Error ? err.message : "Send failed",
        previews: [],
        sentGroups: 0,
        failedGroups: 0,
      });
    } finally {
      setSendLoading(false);
      setConfirmVisible(false);
    }
  }, [previewResult, selectedChannels, cycleDate, readOnly, message]);

  // ── Email Resolver handlers ──
  const handleScan = useCallback(async () => {
    setScanLoading(true);
    setSuggestions([]);
    setSkippedMembers([]);
    setSkippedByReason({});
    setScanSummary(null);
    setSelectedSuggestions(new Set());
    setWriteResult(null);
    setEmailResolveError(null);
    setVerboseUsers([]);
    setVerboseSearch("");
    setSlackTotalCount(0);
    setSlackDeletedCount(0);
    setSlackBotCount(0);
    setSlackAppUserCount(0);
    try {
      const res = await fetch("/api/recurring-intros/resolve-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verbose: verboseMode }),
      });
      const data = await res.json();
      if (!data.success) {
        setEmailResolveError(data.summary || data.error || "Scan failed");
        return;
      }
      setSuggestions(data.suggestions || []);
      setSkippedMembers(data.skipped || []);
      setSkippedByReason(data.skippedByReason || {});
      setScanSummary(data.summary);
      setScanMemberCount(data.memberCount || 0);
      setScanSlackUserCount(data.slackUserCount || 0);
      setSlackWithEmail(data.slackWithEmail || 0);
      setSlackWithoutEmail(data.slackWithoutEmail || 0);
      setVerboseUsers(data.slackUsersVerbose || []);
      setSlackTotalCount(data.slackTotalCount || 0);
      setSlackDeletedCount(data.slackDeletedCount || 0);
      setSlackBotCount(data.slackBotCount || 0);
      setSlackAppUserCount(data.appCount || 0);
      setEmailCityFilter(null);
    } catch (err) {
      setEmailResolveError(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanLoading(false);
    }
  }, [verboseMode]);

  const handleWriteEmails = useCallback(async () => {
    if (selectedSuggestions.size === 0) return;
    setWriteLoading(true);
    setWriteResult(null);
    try {
      const updates = suggestions
        .filter((s) => selectedSuggestions.has(s.airtableRecordId))
        .map((s) => ({
          airtableRecordId: s.airtableRecordId,
          suggestedSlackEmail: s.suggestedSlackEmail,
        }));
      const res = await fetch("/api/recurring-intros/resolve-emails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ write: true, updates }),
      });
      const data = await res.json();
      setWriteResult({ written: data.written || 0, failed: data.failed || 0, errors: data.errors || [] });
      if (data.success) {
        message.success(`Written ${data.written} Slack Email(s) to Airtable`);
        setScanSummary(null);
        setSuggestions([]);
        setSelectedSuggestions(new Set());
      } else {
        message.error(data.message || data.error || "Write failed");
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Write failed");
    } finally {
      setWriteLoading(false);
      setWriteConfirmVisible(false);
    }
  }, [selectedSuggestions, suggestions, message]);

  function toggleSuggestion(id: string) {
    setSelectedSuggestions((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAllSuggestions(select: boolean) {
    if (select) {
      setSelectedSuggestions(new Set(suggestions.map((s) => s.airtableRecordId)));
    } else {
      setSelectedSuggestions(new Set());
    }
  }

  const confidenceColor: Record<string, string> = {
    high: "green",
    low: "red",
  };

  // ── Slack Users tab handler ──
  const handleFetchSlackUsers = useCallback(async (checkScopes?: boolean) => {
    setSlackUsersLoading(true);
    setSlackUsersList([]);
    setSlackUsersSummary(null);
    setAuthScopes([]);
    setAuthTeam("");
    setAuthError(null);
    try {
      const res = await fetch("/api/recurring-intros/slack-users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ checkScopes }),
      });
      const data = await res.json();
      setSlackUsersList(data.users || []);
      setSlackUsersSummary(data.summary || "");
      setSlackActiveCount(data.activeCount || 0);
      setSlackDeletedCount(data.deletedCount || 0);
      setSlackBotCount(data.botCount || 0);
      setSlackAppUserCount(data.appCount || 0);
      if (data.authScopes) setAuthScopes(data.authScopes);
      if (data.authTeam) setAuthTeam(data.authTeam);
      if (data.authError) setAuthError(data.authError);
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Failed to fetch Slack users");
    } finally {
      setSlackUsersLoading(false);
    }
  }, [message]);

  const activeResult = sendResult || previewResult;
  const totalGroups = activeResult?.previews.reduce((n, p) => n + p.proposedGroups.filter((g) => !g.unmatched).length, 0) || 0;
  const totalEligible = activeResult?.previews.reduce((n, p) => n + p.eligibleMembers.length, 0) || 0;
  const totalUnmatched = activeResult?.previews.reduce((n, p) => n + p.unmatchedMembers.length, 0) || 0;
  const totalExcluded = activeResult?.previews.reduce(
    (n, p) => n + Object.values(p.excludedByReason).flat().length,
    0
  ) || 0;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <Title level={3}>
        <SwapOutlined style={{ marginRight: 8 }} />
        Recurring City Intros
      </Title>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title="Slack tools moved"
        description={
          <span>
            Slack linking, removal and invites now live under{" "}
            <a href="/members/slack-access">Member Management → Slack Community</a>.
            This page focuses only on recurring introductions.
          </span>
        }
      />

      {/* Runtime mode banner */}
      {readOnly ? (
        <Alert
          type="info"
          title="Read-only mode"
          description="This preview uses real Airtable, Slack and introduction-history data. No database records will be changed and no messages will be sent."
          style={{ marginBottom: 16 }}
          showIcon
        />
      ) : (
        <Alert
          type="warning"
          title="Live mode"
          description="This mode uses real data, writes to production systems and can send real Slack or email introductions."
          style={{ marginBottom: 16 }}
          showIcon
        />
      )}

      {/* Controls */}
      <Card style={{ marginBottom: 16 }}>
        <Space wrap size="middle">
          <div>
            <Text strong>Due Only</Text>
            <br />
            <Switch
              checked={dueOnly}
              onChange={(v) => {
                setDueOnly(v);
                clearPreview();
              }}
            />
          </div>
          <div>
            <Text strong>Cycle Date</Text>
            <br />
            <DatePicker
              value={cycleDate}
              onChange={(d) => {
                setCycleDate(d);
                clearPreview();
              }}
              format="YYYY-MM-DD"
            />
          </div>
          <div style={{ minWidth: 300 }}>
            <Text strong>Channels (optional)</Text>
            <br />
            <Select
              mode="tags"
              placeholder="All channels or type record IDs"
              value={selectedChannels}
              onChange={(v) => {
                setSelectedChannels(v);
                clearPreview();
              }}
              style={{ width: "100%" }}
            />
          </div>
          <div style={{ alignSelf: "flex-end" }}>
            <Button
              type="primary"
              icon={<EyeOutlined />}
              onClick={handlePreview}
              loading={previewLoading}
            >
              Preview
            </Button>
          </div>
          <div style={{ alignSelf: "flex-end" }}>
            <Button
              danger
              icon={<SendOutlined />}
              onClick={() => setConfirmVisible(true)}
              loading={sendLoading}
              disabled={readOnly || !sendEnabled || !previewResult || totalGroups === 0}
            >
              Send
            </Button>
          </div>
        </Space>
        {previewResult && (
          <div style={{ marginTop: 12 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Mode: {previewResult.mode || introConfig?.mode || "—"} ·{" "}
              {previewResult.sendable === false || readOnly
                ? "Not sendable · Not saved"
                : "Preview ready"}
              {previewResult.requestId ? ` · requestId: ${previewResult.requestId}` : ""}
            </Text>
          </div>
        )}
      </Card>

      {/* Summary cards */}
      {activeResult && (
        <Flex gap={16} style={{ marginBottom: 16 }} wrap>
          <Card size="small" style={{ flex: 1, minWidth: 150 }}>
            <Text type="secondary">Channels</Text>
            <br />
            <Text strong style={{ fontSize: 24 }}>
              {activeResult.previews.length}
            </Text>
          </Card>
          <Card size="small" style={{ flex: 1, minWidth: 150 }}>
            <Text type="secondary">Eligible Members</Text>
            <br />
            <Text strong style={{ fontSize: 24 }}>
              {totalEligible}
            </Text>
          </Card>
          <Card size="small" style={{ flex: 1, minWidth: 150 }}>
            <Text type="secondary">Groups</Text>
            <br />
            <Text strong style={{ fontSize: 24 }}>
              {totalGroups}
            </Text>
          </Card>
          <Card size="small" style={{ flex: 1, minWidth: 150 }}>
            <Text type="secondary">Unmatched</Text>
            <br />
            <Text strong style={{ fontSize: 24 }}>
              {totalUnmatched}
            </Text>
          </Card>
          <Card size="small" style={{ flex: 1, minWidth: 150 }}>
            <Text type="secondary">Excluded</Text>
            <br />
            <Text strong style={{ fontSize: 24 }}>
              {totalExcluded}
            </Text>
          </Card>
          {sendResult && (
            <>
              <Card size="small" style={{ flex: 1, minWidth: 150 }}>
                <Text type="secondary">Sent</Text>
                <br />
                <Text strong style={{ fontSize: 24, color: "#52c41a" }}>
                  {sendResult.sentGroups}
                </Text>
              </Card>
              <Card size="small" style={{ flex: 1, minWidth: 150 }}>
                <Text type="secondary">Failed</Text>
                <br />
                <Text strong style={{ fontSize: 24, color: "#ff4d4f" }}>
                  {sendResult.failedGroups}
                </Text>
              </Card>
            </>
          )}
        </Flex>
      )}

      {/* Loading */}
      {previewLoading && (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Spin size="large" />
          <div style={{ marginTop: 16 }}>
            <Text type="secondary">Loading preview...</Text>
          </div>
        </div>
      )}

      {/* Channel previews */}
      {activeResult && !previewLoading && (
        <div>
          {activeResult.previews.length === 0 ? (
            <Empty description="No channels to preview" />
          ) : (
            activeResult.previews.map((preview, idx) => (
              <Card
                key={idx}
                title={
                  <Space>
                    <span>{preview.channelName}</span>
                    <Tag color="blue">{preview.cityName}</Tag>
                    {preview.isDue ? (
                      <Badge status="success" text="Due" />
                    ) : (
                      <Badge status="default" text="Not due" />
                    )}
                  </Space>
                }
                style={{ marginBottom: 16 }}
              >
                <Flex gap={16} wrap style={{ marginBottom: 16 }}>
                  <div>
                    <Text type="secondary">Cycle ID</Text>
                    <br />
                    <Text code>{preview.cycleId}</Text>
                  </div>
                  <div>
                    <Text type="secondary">Group size</Text>
                    <br />
                    <Text>{preview.config.groupSize} ({preview.config.strictGroupSize ? "strict" : "flexible"})</Text>
                  </div>
                  <div>
                    <Text type="secondary">Frequency</Text>
                    <br />
                    <Text>Every {preview.config.introFrequencyWeeks} week(s)</Text>
                  </div>
                  <div>
                    <Text type="secondary">Slack users in channel</Text>
                    <br />
                    <Text>{preview.slackUserCount}</Text>
                  </div>
                </Flex>

                {/* Calendar warning */}
                {preview.calendarWarning && (
                  <Alert
                    type="warning"
                    title={preview.calendarWarning}
                    icon={<CalendarOutlined />}
                    style={{ marginBottom: 16 }}
                    showIcon
                  />
                )}

                {/* Repeat warnings */}
                {preview.recentRepeatWarnings.length > 0 && (
                  <Alert
                    type="warning"
                    title="Recent Repeat Warnings"
                    description={
                      <ul style={{ margin: 0, paddingLeft: 20 }}>
                        {preview.recentRepeatWarnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    }
                    style={{ marginBottom: 16 }}
                    showIcon
                  />
                )}

                {/* Channel membership error */}
                {preview.channelMembershipError && (
                  <Alert
                    type="error"
                    title={preview.channelMembershipError}
                    style={{ marginBottom: 16 }}
                    showIcon
                  />
                )}

                {/* Groups */}
                <Title level={5}>Proposed Groups</Title>
                {preview.proposedGroups.filter((g) => !g.unmatched).length === 0 ? (
                  <Empty description="No groups formed" />
                ) : (
                  <Table
                    dataSource={preview.proposedGroups
                      .filter((g) => !g.unmatched)
                      .map((g, i) => ({
                        key: i,
                        group: i + 1,
                        members: g.members.map((m) => m.name).join(", "),
                        size: g.members.length,
                      }))}
                    columns={[
                      { title: "Group", dataIndex: "group", width: 60 },
                      { title: "Members", dataIndex: "members" },
                      { title: "Size", dataIndex: "size", width: 60 },
                    ]}
                    pagination={false}
                    size="small"
                    style={{ marginBottom: 16 }}
                  />
                )}

                {/* Unmatched */}
                {preview.unmatchedMembers.length > 0 && (
                  <>
                    <Title level={5}>
                      <UserDeleteOutlined /> Unmatched ({preview.unmatchedMembers.length})
                    </Title>
                    <Text type="secondary">
                      {preview.unmatchedMembers.map((m) => m.name).join(", ")}
                    </Text>
                  </>
                )}

                {/* Excluded */}
                {Object.keys(preview.excludedByReason).length > 0 && (
                  <>
                    <Divider />
                    <Title level={5}>Excluded Members</Title>
                    {Object.entries(preview.excludedByReason).map(([reason, members]) => (
                      <div key={reason} style={{ marginBottom: 8 }}>
                        <Tag color="red">{reason}</Tag>
                        <Text type="secondary">
                          {members.map((m) => m.name).join(", ")}
                        </Text>
                      </div>
                    ))}
                  </>
                )}

                {/* Not found / not on Slack */}
                {(preview.membersNotFoundInAirtable.length > 0 ||
                  preview.airtableMembersNotOnSlack.length > 0) && (
                  <>
                    <Divider />
                    {preview.membersNotFoundInAirtable.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <Text type="secondary">
                          Not in Airtable: {preview.membersNotFoundInAirtable.join(", ")}
                        </Text>
                      </div>
                    )}
                    {preview.airtableMembersNotOnSlack.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        <Text type="secondary">
                          Not on Slack: {preview.airtableMembersNotOnSlack.join(", ")}
                        </Text>
                      </div>
                    )}
                  </>
                )}

                {/* Rendered messages */}
                {preview.renderedMessages.length > 0 && (
                  <>
                    <Divider />
                    <Title level={5}>Slack Message Preview</Title>
                    {preview.renderedMessages.map((msg, i) => (
                      <Card
                        key={i}
                        size="small"
                        style={{
                          marginBottom: 8,
                          background: "#f6f6f6",
                          fontFamily: "monospace",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        <Text>{msg}</Text>
                      </Card>
                    ))}
                  </>
                )}
              </Card>
            ))
          )}
        </div>
      )}

      {/* Skipped channels — collapsed at bottom */}
      {activeResult?.skippedChannels && activeResult.skippedChannels.length > 0 && (
        <Collapse
          style={{ marginTop: 16 }}
          size="small"
          items={[{
            key: "skipped-intros",
            label: (
              <Text type="secondary">
                Skipped Channels ({activeResult.skippedChannels.length})
              </Text>
            ),
            children: (
              <Table
                dataSource={activeResult.skippedChannels.map((s, i) => ({ key: i, ...s }))}
                columns={[
                  { title: "Channel", dataIndex: "name" },
                  { title: "Reason", dataIndex: "reason" },
                ]}
                pagination={false}
                size="small"
              />
            ),
          }]}
        />
      )}

      {/* Confirmation modal */}
      <Modal
        title="Confirm Send"
        open={confirmVisible}
        onOk={handleSend}
        onCancel={() => setConfirmVisible(false)}
        confirmLoading={sendLoading}
        okText="Send Messages"
        okButtonProps={{ danger: true }}
      >
        <Alert
          type="warning"
          title="This will send Slack group DMs to all proposed groups."
          style={{ marginBottom: 16 }}
        />
        <Paragraph>
          <strong>{totalGroups}</strong> group(s) will be created across{" "}
          <strong>{activeResult?.previews.length || 0}</strong> channel(s).
        </Paragraph>
        <Paragraph>
          <strong>{totalEligible}</strong> members will be introduced.
        </Paragraph>
        {totalUnmatched > 0 && (
          <Paragraph type="warning">
            <WarningOutlined /> <strong>{totalUnmatched}</strong> member(s) will be unmatched.
          </Paragraph>
        )}
      </Modal>
    </div>
  );
}
