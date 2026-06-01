"use client";

import { useState, useCallback } from "react";
import { Button, Card, Collapse, DatePicker, Divider, Empty, Flex, Input, Modal, Select, Spin, Table, Tag, Typography, Space, message, Checkbox } from "antd";
import { SearchOutlined, MailOutlined, CheckCircleOutlined, SyncOutlined, SettingOutlined, DownOutlined, UpOutlined, EditOutlined, CopyOutlined, TeamOutlined, CalendarOutlined as CalendarIcon, SlackOutlined, SendOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { generateMatchMessage } from "@/lib/messaging/generate-match-message";

const { RangePicker } = DatePicker;

const { Title, Text, Paragraph } = Typography;

const CITY_OPTIONS = [
  { value: "All Cities", label: "All Cities" },
  { value: "Adelaide", label: "Adelaide" },
  { value: "Asheville", label: "Asheville" },
  { value: "Atlanta", label: "Atlanta" },
  { value: "Austin", label: "Austin" },
  { value: "Barcelona", label: "Barcelona" },
  { value: "Boston", label: "Boston" },
  { value: "Brisbane", label: "Brisbane" },
  { value: "Buenos Aires", label: "Buenos Aires" },
  { value: "Cape Town", label: "Cape Town" },
  { value: "Charleston", label: "Charleston" },
  { value: "Charlotte", label: "Charlotte" },
  { value: "Chicago", label: "Chicago" },
  { value: "Cincinnati", label: "Cincinnati" },
  { value: "Cleveland", label: "Cleveland" },
  { value: "Columbus", label: "Columbus" },
  { value: "Dallas", label: "Dallas" },
  { value: "Denver", label: "Denver" },
  { value: "Detroit", label: "Detroit" },
  { value: "Doha", label: "Doha" },
  { value: "Dubai", label: "Dubai" },
  { value: "Dublin", label: "Dublin" },
  { value: "Edinburgh", label: "Edinburgh" },
  { value: "Houston", label: "Houston" },
  { value: "Indianapolis", label: "Indianapolis" },
  { value: "Jacksonville", label: "Jacksonville" },
  { value: "Kansas City", label: "Kansas City" },
  { value: "Kuala Lumpur", label: "Kuala Lumpur" },
  { value: "Las Vegas", label: "Las Vegas" },
  { value: "Lisbon", label: "Lisbon" },
  { value: "London", label: "London" },
  { value: "Los Angeles", label: "Los Angeles" },
  { value: "Madison", label: "Madison" },
  { value: "Melbourne", label: "Melbourne" },
  { value: "Memphis", label: "Memphis" },
  { value: "Mexico City", label: "Mexico City" },
  { value: "Miami", label: "Miami" },
  { value: "Minneapolis", label: "Minneapolis" },
  { value: "Montreal", label: "Montreal" },
  { value: "Nashville", label: "Nashville" },
  { value: "New York", label: "New York" },
  { value: "Orange County", label: "Orange County" },
  { value: "Orlando", label: "Orlando" },
  { value: "Palm Springs", label: "Palm Springs" },
  { value: "Paris", label: "Paris" },
  { value: "Perth", label: "Perth" },
  { value: "Philadelphia", label: "Philadelphia" },
  { value: "Phoenix", label: "Phoenix" },
  { value: "Pittsburgh", label: "Pittsburgh" },
  { value: "Portland", label: "Portland" },
  { value: "Raleigh", label: "Raleigh" },
  { value: "Richmond", label: "Richmond" },
  { value: "Sacramento", label: "Sacramento" },
  { value: "Salt Lake City", label: "Salt Lake City" },
  { value: "San Antonio", label: "San Antonio" },
  { value: "San Diego", label: "San Diego" },
  { value: "San Francisco", label: "San Francisco" },
  { value: "Sao Paulo", label: "Sao Paulo" },
  { value: "Seattle", label: "Seattle" },
  { value: "Singapore", label: "Singapore" },
  { value: "Spokane", label: "Spokane" },
  { value: "St Louis", label: "St Louis" },
  { value: "Sydney", label: "Sydney" },
  { value: "Tampa", label: "Tampa" },
  { value: "Toronto", label: "Toronto" },
  { value: "Tucson", label: "Tucson" },
  { value: "Vancouver", label: "Vancouver" },
  { value: "Washington DC", label: "Washington DC" },
];

interface MemberFields {
  name: string;
  email: string;
  postcode: string;
  city: string;
  nearbyLocation: string;
  active: boolean;
  industry: string;
  traction: string;
  hasBusinessDomain: boolean;
  businessStage: string;
}

interface MatchedMember extends MemberFields {
  id: string;
  similarityScore: number;
}

type SearchMember = MemberFields;

interface MatchApiResponse {
  success: boolean;
  email: string;
  member: SearchMember;
  matches: MatchedMember[];
  error?: string;
}

interface SyncApiResponse {
  success: boolean;
  summary: string;
  logs: string[];
  recordsProcessed?: number;
  error?: string;
}

interface BatchMemberProfile {
  nearbyLocation: string;
  businessStage: string;
  hasBusinessDomain: boolean;
  active: boolean;
}

interface BatchNewMember {
  id: string;
  name: string;
  email: string;
  city: string;
  postcode: string;
  industry: string;
  traction: string;
  dateAdded: string;
  inPinecone: boolean;
  profile: BatchMemberProfile | null;
  matches: MatchedMember[];
}

interface BatchCityGroup {
  city: string;
  count: number;
  members: BatchNewMember[];
}

interface BatchApiResponse {
  success: boolean;
  startDate: string;
  endDate: string;
  totalNewMembers: number;
  totalWithMatches: number;
  cities: BatchCityGroup[];
  error?: string;
}

const DATE_PRESETS: Array<{ label: string; value: [Dayjs, Dayjs] }> = [
  { label: "Today", value: [dayjs(), dayjs()] },
  { label: "Last 3 Days", value: [dayjs().subtract(2, "day"), dayjs()] },
  { label: "Last 7 Days", value: [dayjs().subtract(6, "day"), dayjs()] },
  { label: "Last 14 Days", value: [dayjs().subtract(13, "day"), dayjs()] },
  { label: "Last 30 Days", value: [dayjs().subtract(29, "day"), dayjs()] },
];

function scoreColor(score: number): string {
  if (score >= 0.85) return "#52c41a";
  if (score >= 0.7) return "#1890ff";
  if (score >= 0.55) return "#faad14";
  return "#ff4d4f";
}

function LocationText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setExpanded((prev) => !prev);
  }, []);

  if (!text) return null;

  return (
    <div style={{ minWidth: 0, flex: 1 }}>
      <div
        style={{
          fontSize: 12,
          lineHeight: "18px",
          color: "rgba(0,0,0,0.45)",
          wordBreak: "break-word",
          maxHeight: expanded ? "none" : 36,
          overflow: "hidden",
        }}
      >
        {text}
      </div>
      <a
        onClick={toggle}
        style={{ fontSize: 11, cursor: "pointer" }}
      >
        {expanded ? <UpOutlined /> : <DownOutlined />}{" "}
        {expanded ? "Less" : "More"}
      </a>
    </div>
  );
}

function LabelRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 6, fontSize: 13, lineHeight: "20px" }}>
      <Text type="secondary" style={{ flexShrink: 0, width: 110, fontSize: 12 }}>{label}</Text>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

function MemberCardBody({ m }: { m: MemberFields }) {
  const loc = String(m.nearbyLocation || "");
  const trac = String(m.traction || "");
  const stage = String(m.businessStage || "");
  const ind = String(m.industry || "");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <LabelRow label="Postcode">
        <Text style={{ fontSize: 13 }}>{String(m.postcode || "—")}</Text>
      </LabelRow>
      <LabelRow label="City">
        <Text style={{ fontSize: 13 }}>{String(m.city || "—")}</Text>
      </LabelRow>
      <LabelRow label="Nearby">
        {loc ? <LocationText text={loc} /> : <Text type="secondary" style={{ fontSize: 12 }}>—</Text>}
      </LabelRow>
      <LabelRow label="Business Stage">
        <Tag color={stageColor(stage)} style={{ margin: 0 }}>{stage || "—"}</Tag>
      </LabelRow>
      <LabelRow label="Traction">
        <Text style={{ fontSize: 13 }}>{trac || "—"}</Text>
      </LabelRow>
      <LabelRow label="Industry">
        <Text style={{ fontSize: 13 }}>{ind || "—"}</Text>
      </LabelRow>
      <LabelRow label="Business Email">
        <Tag color={m.hasBusinessDomain ? "green" : "default"} style={{ margin: 0 }}>
          {m.hasBusinessDomain ? "Yes" : "No"}
        </Tag>
      </LabelRow>
      <LabelRow label="Active">
        <Tag color={m.active ? "green" : "red"} style={{ margin: 0 }}>
          {m.active ? "Yes" : "No"}
        </Tag>
      </LabelRow>
    </div>
  );
}

function stageColor(stage: string): string {
  const colors: Record<string, string> = {
    "Pre-Revenue": "default",
    "Idea Validation": "blue",
    "Early Traction": "cyan",
    "Initial Product-Market Fit": "geekblue",
    "Growing Traction": "green",
    "Strong Traction": "lime",
    "Early Scale": "gold",
    "Scaling": "orange",
    "Rapid Growth": "volcano",
    "Expansion Stage": "magenta",
    "Established Scale": "purple",
  };
  return colors[stage] ?? "default";
}

export default function GetMatchedPage() {
  // Match state
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<MatchApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Sync state
  const [syncCity, setSyncCity] = useState("London");
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncApiResponse | null>(null);

  async function handleSearch() {
    if (!email.trim()) {
      message.warning("Please enter an email address");
      return;
    }

    setLoading(true);
    setError(null);
    setResponse(null);
    setSelectedIds(new Set());

    try {
      const params = new URLSearchParams({ email: email.trim().toLowerCase() });
      const res = await fetch(`/api/get-matched?${params}`);
      const data = await res.json();

      if (!data.success) {
        setError(data.error || "Failed to find matches");
        return;
      }

      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);

    try {
      const res = await fetch("/api/sync-to-pinecone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city: syncCity }),
      });

      const text = await res.text();
      let data: SyncApiResponse;
      try {
        data = JSON.parse(text);
      } catch {
        setSyncResult({ success: false, summary: `Server returned non-JSON (${res.status}): ${text.slice(0, 200)}`, logs: [] });
        return;
      }

      setSyncResult(data);

      if (data.success) {
        message.success(data.summary);
      } else {
        message.error(data.summary || data.error || "Sync failed");
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 5) {
        next.add(id);
      } else {
        message.warning("You can select up to 5 matches");
      }
      return next;
    });
  }

  function copySelectedEmails() {
    if (!response) return;
    const selected = response.matches.filter((m) => selectedIds.has(m.id));
    const emails = selected.map((m) => m.email).join(", ");
    navigator.clipboard.writeText(emails);
    message.success(`Copied ${selected.length} email(s)`);
  }

  // Draft message state
  const [draftVisible, setDraftVisible] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [draftEmails, setDraftEmails] = useState("");

  function handleDraftMessage() {
    if (!response || selectedIds.size === 0) {
      message.warning("Select at least one match first");
      return;
    }

    const member = response.member;
    const selected = response.matches.filter((m) => selectedIds.has(m.id));

    const msg = generateMatchMessage({
      newMember: {
        name: String(member.name),
        email: String(member.email),
        industry: String(member.industry || ""),
        businessStage: String(member.businessStage || ""),
        nearbyLocation: String(member.nearbyLocation || ""),
      },
      matches: selected.map((m) => ({
        name: String(m.name),
        email: String(m.email),
        industry: String(m.industry || ""),
        businessStage: String(m.businessStage || ""),
        nearbyLocation: String(m.nearbyLocation || ""),
      })),
      format: "plaintext",
    });

    setDraftEmails(msg.recipients.join(", "));
    setDraftText(msg.body);
    setDraftVisible(true);
  }

  function copyDraft() {
    const full = `To: ${draftEmails}\n\n${draftText}`;
    navigator.clipboard.writeText(full);
    message.success("Draft copied to clipboard");
  }

  // ─── Batch match state ───
  const [batchDateRange, setBatchDateRange] = useState<[Dayjs, Dayjs]>([dayjs(), dayjs()]);
  const [batchLoading, setBatchLoading] = useState(false);
  const [batchResult, setBatchResult] = useState<BatchApiResponse | null>(null);
  const [batchError, setBatchError] = useState<string | null>(null);
  const [expandedMember, setExpandedMember] = useState<string | null>(null);
  const [batchSelectedIds, setBatchSelectedIds] = useState<Map<string, Set<string>>>(new Map());
  const [batchDraftVisible, setBatchDraftVisible] = useState(false);
  const [batchDraftText, setBatchDraftText] = useState("");
  const [batchDraftEmails, setBatchDraftEmails] = useState("");

  // ─── Slack intro state ───
  const [slackDateRange, setSlackDateRange] = useState<[Dayjs, Dayjs]>([dayjs(), dayjs()]);
  const [slackEmailInput, setSlackEmailInput] = useState("");
  const [slackLoadMode, setSlackLoadMode] = useState<"date" | "email">("date");
  const [slackLoading, setSlackLoading] = useState(false);
  const [slackSending, setSlackSending] = useState(false);
  interface SlackDeliveryMatch {
    name: string;
    email: string;
    city: string;
    industry: string;
    traction: string;
    businessStage: string;
    nearbyLocation: string;
    hasBusinessDomain: boolean;
    similarityScore: number;
    onSlack: boolean;
  }
  interface SlackDelivery {
    newMemberName: string;
    newMemberEmail: string;
    newMemberCity: string;
    newMemberIndustry: string;
    newMemberTraction: string;
    newMemberNearbyLocation: string;
    newMemberBusinessStage: string;
    newMemberOnSlack: boolean;
    matches: SlackDeliveryMatch[];
    slackMembersFound: string[];
    slackMembersMissing: string[];
    slackSent: boolean;
    slackChannelId: string | null;
    slackMessage: string | null;
    error: string | null;
  }
  const [slackDeliveries, setSlackDeliveries] = useState<SlackDelivery[]>([]);
  const [slackSummary, setSlackSummary] = useState<string | null>(null);
  const [slackError, setSlackError] = useState<string | null>(null);
  const [slackLogs, setSlackLogs] = useState<string[]>([]);
  const [slackPreviewed, setSlackPreviewed] = useState(false);

  async function callMatchIntros(mode: "preview" | "send") {
    const isPreview = mode === "preview";
    if (isPreview) {
      setSlackLoading(true);
      setSlackPreviewed(false);
    } else {
      setSlackSending(true);
    }
    setSlackError(null);
    if (isPreview) {
      setSlackDeliveries([]);
      setSlackSummary(null);
      setSlackLogs([]);
    }

    try {
      const bodyObj: Record<string, unknown> = { mode };
      if (slackLoadMode === "email" && slackEmailInput.trim()) {
        bodyObj.emails = slackEmailInput.split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
      } else {
        bodyObj.startDate = slackDateRange[0].format("YYYY-MM-DD");
        bodyObj.endDate = slackDateRange[1].format("YYYY-MM-DD");
      }

      const res = await fetch("/api/send-match-intros", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bodyObj),
      });
      const data = await res.json();

      if (!data.success) {
        setSlackError(data.summary || data.error || "Failed");
        return;
      }

      setSlackDeliveries(data.deliveries || []);
      setSlackSummary(data.summary);
      setSlackLogs(data.logs || []);
      if (isPreview) {
        setSlackPreviewed(true);
      } else {
        message.success(data.summary);
        setSlackPreviewed(false);
      }
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSlackLoading(false);
      setSlackSending(false);
    }
  }

  async function handleBatchMatch() {
    setBatchLoading(true);
    setBatchError(null);
    setBatchResult(null);
    setExpandedMember(null);
    setBatchSelectedIds(new Map());

    try {
      const startDate = batchDateRange[0].format("YYYY-MM-DD");
      const endDate = batchDateRange[1].format("YYYY-MM-DD");
      const params = new URLSearchParams({ startDate, endDate });
      const res = await fetch(`/api/batch-match?${params}`);
      const text = await res.text();
      let data: BatchApiResponse;
      try {
        data = JSON.parse(text);
      } catch {
        setBatchError(`Server returned non-JSON (${res.status})`);
        return;
      }

      if (!data.success) {
        setBatchError(data.error || "Failed to fetch");
        return;
      }
      setBatchResult(data);
    } catch (err) {
      setBatchError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBatchLoading(false);
    }
  }

  function toggleBatchSelect(memberId: string, matchId: string) {
    setBatchSelectedIds((prev) => {
      const next = new Map(prev);
      const memberSet = new Set(next.get(memberId) ?? []);
      if (memberSet.has(matchId)) {
        memberSet.delete(matchId);
      } else if (memberSet.size < 5) {
        memberSet.add(matchId);
      } else {
        message.warning("You can select up to 5 matches per member");
        return prev;
      }
      next.set(memberId, memberSet);
      return next;
    });
  }

  function handleBatchDraft(newMember: BatchNewMember) {
    const selectedSet = batchSelectedIds.get(newMember.id);
    if (!selectedSet || selectedSet.size === 0) {
      message.warning("Select at least one match first");
      return;
    }

    const selected = newMember.matches.filter((m) => selectedSet.has(m.id));

    const msg = generateMatchMessage({
      newMember: {
        name: newMember.name,
        email: newMember.email,
        industry: newMember.industry,
        businessStage: String(newMember.profile?.businessStage || ""),
        nearbyLocation: String(newMember.profile?.nearbyLocation || ""),
      },
      matches: selected.map((m) => ({
        name: String(m.name),
        email: String(m.email),
        industry: String(m.industry || ""),
        businessStage: String(m.businessStage || ""),
        nearbyLocation: String(m.nearbyLocation || ""),
      })),
      format: "plaintext",
    });

    setBatchDraftEmails(msg.recipients.join(", "));
    setBatchDraftText(msg.body);
    setBatchDraftVisible(true);
  }

  function copyBatchDraft() {
    const full = `To: ${batchDraftEmails}\n\n${batchDraftText}`;
    navigator.clipboard.writeText(full);
    message.success("Draft copied to clipboard");
  }

  const selectedCount = selectedIds.size;

  return (
    <div style={{ maxWidth: 1100 }}>
      {/* Refresh Analysis */}
      <Flex vertical gap="middle" style={{ width: "100%", marginBottom: 24 }}>
        <div>
          <Title level={4} style={{ margin: 0 }}>
            First, refresh analysis to remove members and update existing members
          </Title>
          <Text type="secondary">
            Select a city to sync active members. Cancelled members are automatically removed.
          </Text>
        </div>
        <Space>
          <Select
            value={syncCity}
            onChange={setSyncCity}
            options={CITY_OPTIONS}
            style={{ width: 240 }}
            showSearch
            filterOption={(input, option) =>
              (option?.label ?? "").toLowerCase().includes(input.toLowerCase())
            }
          />
          <Button
            type="primary"
            icon={<SyncOutlined spin={syncing} />}
            onClick={handleSync}
            loading={syncing}
          >
            {syncing ? "Syncing..." : "Sync Now"}
          </Button>
        </Space>
        {syncResult && (
          <Card
            size="small"
            style={{
              background: syncResult.success ? "#f6ffed" : "#fff2f0",
              borderColor: syncResult.success ? "#b7eb8f" : "#ffccc7",
            }}
          >
            <Text strong>{syncResult.summary}</Text>
            {syncResult.logs.length > 0 && (
              <div style={{ marginTop: 8, maxHeight: 200, overflow: "auto" }}>
                {syncResult.logs.map((log, i) => (
                  <div key={i}>
                    <Text type="secondary" style={{ fontSize: 12, fontFamily: "monospace" }}>
                      {log}
                    </Text>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
      </Flex>

      {/* Match Search */}
      <Flex vertical gap="middle" style={{ width: "100%", marginBottom: 24 }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>
            Custom Matching
          </Title>
          <Text type="secondary">
            Enter a member&apos;s email to find their top 8 matches. Select 4-5 for introductions.
          </Text>
        </div>

        <Space>
          <Input
            placeholder="member@example.com"
            prefix={<MailOutlined />}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onPressEnter={handleSearch}
            style={{ width: 360 }}
            size="large"
          />
          <Button
            type="primary"
            icon={<SearchOutlined />}
            onClick={handleSearch}
            loading={loading}
            size="large"
          >
            Find Matches
          </Button>
          <Button
            icon={<EditOutlined />}
            onClick={handleDraftMessage}
            size="large"
            disabled={selectedCount === 0}
          >
            Draft Message {selectedCount > 0 ? `(${selectedCount})` : ""}
          </Button>
        </Space>
      </Flex>

      {error && (
        <Card style={{ marginBottom: 16, borderColor: "#ff4d4f" }}>
          <Text type="danger">{error}</Text>
        </Card>
      )}

      {loading && (
        <div style={{ textAlign: "center", padding: 48 }}>
          <Spin size="large" />
          <div style={{ marginTop: 16 }}>
            <Text type="secondary">Searching for matches...</Text>
          </div>
        </div>
      )}

      {response && !loading && (
        <>
          {/* Selection toolbar */}
          {selectedCount > 0 && (
            <Card size="small" style={{ marginBottom: 16, background: "#e6f7ff", borderColor: "#91d5ff" }}>
              <Space style={{ width: "100%", justifyContent: "space-between" }}>
                <Text strong>
                  <CheckCircleOutlined style={{ marginRight: 8 }} />
                  {selectedCount} match{selectedCount !== 1 ? "es" : ""} selected
                </Text>
                <Button type="primary" size="small" onClick={copySelectedEmails}>
                  Copy Selected Emails
                </Button>
              </Space>
            </Card>
          )}

          {response.matches.length === 0 ? (
            <Empty description="No matches found" />
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 16 }}>
              {/* Searched member as first card in grid */}
              <Card style={{ background: "#f6ffed", borderColor: "#b7eb8f" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Text strong style={{ fontSize: 15 }}>
                      {String(response.member.name)}
                    </Text>
                    <br />
                    <Text type="secondary" style={{ fontSize: 12, wordBreak: "break-all" }}>{String(response.member.email)}</Text>
                  </div>
                  <Tag color="green" style={{ flexShrink: 0, marginLeft: 8, fontWeight: 600 }}>
                    Being matched
                  </Tag>
                </div>
                <MemberCardBody m={response.member} />
              </Card>

              {response.matches.map((match, index) => {
                const isSelected = selectedIds.has(match.id);
                return (
                  <Card
                    key={match.id}
                    hoverable
                    onClick={() => toggleSelect(match.id)}
                    style={{
                      borderColor: isSelected ? "#1890ff" : undefined,
                      borderWidth: isSelected ? 2 : 1,
                      background: isSelected ? "#e6f7ff" : undefined,
                      cursor: "pointer",
                    }}
                  >
                    {/* Header: checkbox, name, email, score */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, flex: 1 }}>
                        <Checkbox checked={isSelected} style={{ flexShrink: 0 }} />
                        <div style={{ minWidth: 0 }}>
                          <Text strong style={{ fontSize: 15 }}>
                            #{index + 1} {match.name}
                          </Text>
                          <br />
                          <Text type="secondary" style={{ fontSize: 12, wordBreak: "break-all" }}>{match.email}</Text>
                        </div>
                      </div>
                      <div
                        style={{
                          background: scoreColor(match.similarityScore),
                          color: "#fff",
                          borderRadius: 8,
                          padding: "2px 10px",
                          fontSize: 14,
                          fontWeight: 600,
                          flexShrink: 0,
                          marginLeft: 8,
                        }}
                      >
                        {Math.round(match.similarityScore * 100)}%
                      </div>
                    </div>

                    <MemberCardBody m={match} />
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ═══════ Batch Match New Members ═══════ */}
      <Divider style={{ marginTop: 40 }} />

      <Flex vertical gap="middle" style={{ width: "100%", marginBottom: 24 }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>
            <TeamOutlined style={{ marginRight: 8 }} />
            Batch Match New Members
          </Title>
          <Text type="secondary">
            Select a date range to find new members, then auto-match each one.
          </Text>
        </div>

        <Space wrap>
          <RangePicker
            value={batchDateRange}
            onChange={(dates) => {
              if (dates && dates[0] && dates[1]) setBatchDateRange([dates[0], dates[1]]);
            }}
            presets={DATE_PRESETS}
            disabledDate={(current) => current && current.isAfter(dayjs(), "day")}
            allowClear={false}
          />
          <Button
            type="primary"
            icon={<SearchOutlined />}
            onClick={handleBatchMatch}
            loading={batchLoading}
          >
            Find &amp; Match New Members
          </Button>
        </Space>
      </Flex>

      {batchError && (
        <Card style={{ marginBottom: 16, borderColor: "#ff4d4f" }}>
          <Text type="danger">{batchError}</Text>
        </Card>
      )}

      {batchLoading && (
        <div style={{ textAlign: "center", padding: 48 }}>
          <Spin size="large" />
          <div style={{ marginTop: 16 }}>
            <Text type="secondary">Fetching new members and computing matches...</Text>
          </div>
        </div>
      )}

      {batchResult && !batchLoading && (
        <div>
          <Card size="small" style={{ marginBottom: 16, background: "#f6ffed", borderColor: "#b7eb8f" }}>
            <Space split={<Divider type="vertical" />}>
              <Text strong>{batchResult.totalNewMembers} new member(s)</Text>
              <Text>{batchResult.totalWithMatches} synced in Pinecone</Text>
              <Text>{batchResult.cities.length} city/cities</Text>
              <Text type="secondary">{batchResult.startDate} to {batchResult.endDate}</Text>
            </Space>
          </Card>

          {batchResult.cities.length === 0 ? (
            <Empty description="No new members in this date range" />
          ) : (
            <Collapse
              accordion
              defaultActiveKey={batchResult.cities[0]?.city}
              items={batchResult.cities.map((cityGroup) => ({
                key: cityGroup.city,
                label: (
                  <Space>
                    <Text strong>{cityGroup.city}</Text>
                    <Tag>{cityGroup.count} new member(s)</Tag>
                  </Space>
                ),
                children: (
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                    {cityGroup.members.map((newMember) => {
                      const isExpanded = expandedMember === newMember.id;
                      const memberSelections = batchSelectedIds.get(newMember.id) ?? new Set();
                      const selCount = memberSelections.size;

                      return (
                        <Card
                          key={newMember.id}
                          size="small"
                          style={{ borderColor: isExpanded ? "#1890ff" : undefined }}
                        >
                          {/* New member header */}
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: isExpanded ? 12 : 0 }}>
                            <div>
                              <Text strong>{newMember.name}</Text>
                              <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>{newMember.email}</Text>
                              <br />
                              <Space size={4} style={{ marginTop: 4 }}>
                                <Tag>{newMember.city}</Tag>
                                {newMember.industry && <Tag>{newMember.industry}</Tag>}
                                {newMember.traction && <Tag>{newMember.traction}</Tag>}
                                {!newMember.inPinecone && <Tag color="orange">Not synced</Tag>}
                              </Space>
                            </div>
                            <Space>
                              <Button
                                size="small"
                                type={isExpanded ? "primary" : "default"}
                                onClick={() => setExpandedMember(isExpanded ? null : newMember.id)}
                                disabled={!newMember.inPinecone || newMember.matches.length === 0}
                                icon={<SearchOutlined />}
                              >
                                {isExpanded ? "Hide Matches" : `Show Matches (${newMember.matches.length})`}
                              </Button>
                              <Button
                                size="small"
                                icon={<EditOutlined />}
                                onClick={(e) => { e.stopPropagation(); handleBatchDraft(newMember); }}
                                disabled={selCount === 0}
                              >
                                Draft Message{selCount > 0 ? ` (${selCount})` : ""}
                              </Button>
                            </Space>
                          </div>

                          {/* Expanded matches grid */}
                          {isExpanded && newMember.matches.length > 0 && (
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12, marginTop: 8 }}>
                              {/* Being matched card — first in grid */}
                              <Card
                                size="small"
                                style={{ background: "#f6ffed", borderColor: "#b7eb8f" }}
                              >
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                                  <div style={{ minWidth: 0, flex: 1 }}>
                                    <Text strong style={{ fontSize: 13 }}>{newMember.name}</Text>
                                    <br />
                                    <Text type="secondary" style={{ fontSize: 11, wordBreak: "break-all" }}>{newMember.email}</Text>
                                  </div>
                                  <Tag color="green" style={{ flexShrink: 0, marginLeft: 6, fontWeight: 600 }}>
                                    Being matched
                                  </Tag>
                                </div>
                                <MemberCardBody m={{
                                  name: newMember.name,
                                  email: newMember.email,
                                  postcode: newMember.postcode,
                                  city: newMember.city,
                                  nearbyLocation: newMember.profile?.nearbyLocation ?? "",
                                  active: newMember.profile?.active ?? true,
                                  industry: newMember.industry,
                                  traction: newMember.traction,
                                  hasBusinessDomain: newMember.profile?.hasBusinessDomain ?? false,
                                  businessStage: newMember.profile?.businessStage ?? "",
                                }} />
                              </Card>

                              {newMember.matches.map((match, idx) => {
                                const isSelected = memberSelections.has(match.id);
                                return (
                                  <Card
                                    key={match.id}
                                    size="small"
                                    hoverable
                                    onClick={() => toggleBatchSelect(newMember.id, match.id)}
                                    style={{
                                      borderColor: isSelected ? "#1890ff" : undefined,
                                      borderWidth: isSelected ? 2 : 1,
                                      background: isSelected ? "#e6f7ff" : undefined,
                                      cursor: "pointer",
                                    }}
                                  >
                                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                                      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, flex: 1 }}>
                                        <Checkbox checked={isSelected} style={{ flexShrink: 0 }} />
                                        <div style={{ minWidth: 0 }}>
                                          <Text strong style={{ fontSize: 13 }}>#{idx + 1} {match.name}</Text>
                                          <br />
                                          <Text type="secondary" style={{ fontSize: 11, wordBreak: "break-all" }}>{match.email}</Text>
                                        </div>
                                      </div>
                                      <div style={{
                                        background: scoreColor(match.similarityScore),
                                        color: "#fff", borderRadius: 6,
                                        padding: "1px 8px", fontSize: 12, fontWeight: 600,
                                        flexShrink: 0, marginLeft: 6,
                                      }}>
                                        {Math.round(match.similarityScore * 100)}%
                                      </div>
                                    </div>
                                    <MemberCardBody m={match} />
                                  </Card>
                                );
                              })}
                            </div>
                          )}
                        </Card>
                      );
                    })}
                  </div>
                ),
              }))}
            />
          )}
        </div>
      )}

      {/* ═══════ Send Slack Introductions ═══════ */}
      <Divider style={{ marginTop: 40 }} />

      <Flex vertical gap="middle" style={{ width: "100%", marginBottom: 24 }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>
            <SlackOutlined style={{ marginRight: 8 }} />
            Send Slack Introductions
          </Title>
          <Text type="secondary">
            Load members by email or date range, preview matches, then approve to send Slack group DMs.
          </Text>
        </div>

        <Flex gap={8} align="center">
          <Select
            value={slackLoadMode}
            onChange={(v) => { setSlackLoadMode(v); setSlackPreviewed(false); setSlackDeliveries([]); setSlackSummary(null); }}
            options={[
              { value: "date", label: "By date range" },
              { value: "email", label: "By email" },
            ]}
            style={{ width: 150 }}
          />
          {slackLoadMode === "date" ? (
            <RangePicker
              value={slackDateRange}
              onChange={(dates) => {
                if (dates && dates[0] && dates[1]) setSlackDateRange([dates[0], dates[1]]);
              }}
              presets={DATE_PRESETS}
              disabledDate={(current) => current && current.isAfter(dayjs(), "day")}
              allowClear={false}
            />
          ) : (
            <Input
              placeholder="member@example.com (comma-separated)"
              value={slackEmailInput}
              onChange={(e) => setSlackEmailInput(e.target.value)}
              style={{ width: 400 }}
              prefix={<MailOutlined />}
            />
          )}
          <Button
            type="primary"
            icon={<SearchOutlined />}
            onClick={() => callMatchIntros("preview")}
            loading={slackLoading}
          >
            {slackLoading ? "Loading..." : "Preview Matches"}
          </Button>
        </Flex>
      </Flex>

      {slackError && (
        <Card style={{ marginBottom: 16, borderColor: "#ff4d4f" }}>
          <Text type="danger">{slackError}</Text>
        </Card>
      )}

      {slackLoading && (
        <div style={{ textAlign: "center", padding: 48 }}>
          <Spin size="large" />
          <div style={{ marginTop: 16 }}>
            <Text type="secondary">Matching members and checking Slack...</Text>
          </div>
        </div>
      )}

      {slackSummary && !slackLoading && (
        <Flex vertical gap={16} style={{ marginBottom: 24 }}>
          <Card size="small" style={{ background: slackPreviewed ? "#e6f7ff" : "#f6ffed", borderColor: slackPreviewed ? "#91d5ff" : "#b7eb8f" }}>
            <Flex justify="space-between" align="center">
              <div>
                <Text strong>{slackSummary}</Text>
                {slackPreviewed && (
                  <div style={{ marginTop: 4 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      <SlackOutlined style={{ marginRight: 4 }} />
                      {slackDeliveries.reduce((n, d) => n + d.slackMembersFound.length, 0)} members on Slack,{" "}
                      {slackDeliveries.reduce((n, d) => n + d.slackMembersMissing.length, 0)} not on Slack
                    </Text>
                  </div>
                )}
              </div>
              {slackPreviewed && slackDeliveries.some((d) => !d.error && d.slackMembersFound.length >= 2) && (
                <Button
                  type="primary"
                  danger
                  icon={<SendOutlined />}
                  onClick={() => callMatchIntros("send")}
                  loading={slackSending}
                  size="large"
                >
                  {slackSending ? "Sending..." : "Approve & Send Slack Messages"}
                </Button>
              )}
              {!slackPreviewed && slackDeliveries.some((d) => d.slackSent) && (
                <Tag color="green" style={{ fontSize: 14, padding: "4px 12px" }}>Messages Sent</Tag>
              )}
            </Flex>
          </Card>

          {slackDeliveries.map((delivery) => (
            <Card
              key={delivery.newMemberEmail}
              size="small"
              style={{
                borderColor: delivery.slackSent ? "#b7eb8f" : delivery.error ? "#ffccc7" : undefined,
              }}
            >
              {/* New member header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                <div>
                  <Text strong>{delivery.newMemberName}</Text>
                  <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>{delivery.newMemberEmail}</Text>
                  <br />
                  <Space size={4} style={{ marginTop: 4 }}>
                    {delivery.newMemberCity && <Tag>{delivery.newMemberCity}</Tag>}
                    {delivery.newMemberIndustry && <Tag>{delivery.newMemberIndustry}</Tag>}
                    {delivery.newMemberTraction && <Tag>{delivery.newMemberTraction}</Tag>}
                    {delivery.newMemberOnSlack ? <Tag color="blue"><SlackOutlined /> On Slack</Tag> : <Tag>Not on Slack</Tag>}
                    {delivery.error && <Tag color="red">{delivery.error}</Tag>}
                    {delivery.slackSent && <Tag color="green">Slack DM Sent</Tag>}
                    {!delivery.slackSent && !delivery.error && slackPreviewed && delivery.slackMembersFound.length >= 2 && (
                      <Tag color="blue">Ready to send</Tag>
                    )}
                  </Space>
                </div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {delivery.slackMembersFound.length}/{delivery.slackMembersFound.length + delivery.slackMembersMissing.length} on Slack
                </Text>
              </div>

              {/* Match cards grid */}
              {delivery.matches.length > 0 && (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
                  {/* Being matched card */}
                  <Card size="small" style={{ background: "#f6ffed", borderColor: "#b7eb8f" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <Text strong style={{ fontSize: 13 }}>{delivery.newMemberName}</Text>
                        <br />
                        <Text type="secondary" style={{ fontSize: 11, wordBreak: "break-all" }}>{delivery.newMemberEmail}</Text>
                      </div>
                      <Tag color="green" style={{ flexShrink: 0, marginLeft: 6, fontWeight: 600 }}>Being matched</Tag>
                    </div>
                    <MemberCardBody m={{
                      name: delivery.newMemberName,
                      email: delivery.newMemberEmail,
                      postcode: "",
                      city: delivery.newMemberCity,
                      nearbyLocation: delivery.newMemberNearbyLocation,
                      active: true,
                      industry: delivery.newMemberIndustry,
                      traction: delivery.newMemberTraction,
                      hasBusinessDomain: false,
                      businessStage: delivery.newMemberBusinessStage,
                    }} />
                  </Card>

                  {/* Match cards */}
                  {delivery.matches.map((match, idx) => (
                    <Card
                      key={match.email}
                      size="small"
                      style={{
                        borderColor: match.onSlack ? "#91d5ff" : undefined,
                        background: match.onSlack ? "#f0f5ff" : undefined,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <Text strong style={{ fontSize: 13 }}>#{idx + 1} {match.name}</Text>
                          <br />
                          <Text type="secondary" style={{ fontSize: 11, wordBreak: "break-all" }}>{match.email}</Text>
                        </div>
                        <Flex gap={4} align="center" style={{ flexShrink: 0, marginLeft: 6 }}>
                          {match.onSlack && <Tag color="blue"><SlackOutlined /> Slack</Tag>}
                          <div style={{
                            background: scoreColor(match.similarityScore),
                            color: "#fff", borderRadius: 6,
                            padding: "1px 8px", fontSize: 12, fontWeight: 600,
                          }}>
                            {Math.round(match.similarityScore * 100)}%
                          </div>
                        </Flex>
                      </div>
                      <MemberCardBody m={{
                        name: match.name,
                        email: match.email,
                        postcode: "",
                        city: match.city,
                        nearbyLocation: match.nearbyLocation,
                        active: true,
                        industry: match.industry,
                        traction: match.traction,
                        hasBusinessDomain: match.hasBusinessDomain,
                        businessStage: match.businessStage,
                      }} />
                    </Card>
                  ))}
                </div>
              )}

              {/* Slack message preview */}
              {delivery.slackMessage && (
                <Collapse
                  style={{ marginTop: 12 }}
                  items={[{
                    key: "msg",
                    label: <Text type="secondary" style={{ fontSize: 12 }}>Slack message preview</Text>,
                    children: (
                      <pre style={{ margin: 0, fontSize: 12, lineHeight: "18px", whiteSpace: "pre-wrap", background: "#f5f5f5", padding: 12, borderRadius: 6 }}>
                        {delivery.slackMessage}
                      </pre>
                    ),
                  }]}
                />
              )}
            </Card>
          ))}

          {slackLogs.length > 0 && (
            <Collapse
              items={[{
                key: "logs",
                label: <Text type="secondary">Execution logs ({slackLogs.length} lines)</Text>,
                children: (
                  <div style={{ maxHeight: 200, overflow: "auto" }}>
                    {slackLogs.map((log, i) => (
                      <div key={i}>
                        <Text type="secondary" style={{ fontSize: 12, fontFamily: "monospace" }}>{log}</Text>
                      </div>
                    ))}
                  </div>
                ),
              }]}
            />
          )}
        </Flex>
      )}

      {/* Batch Draft Modal */}
      <Modal
        title="Draft Introduction Message"
        open={batchDraftVisible}
        onCancel={() => setBatchDraftVisible(false)}
        width={680}
        footer={[
          <Button key="close" onClick={() => setBatchDraftVisible(false)}>Close</Button>,
          <Button key="copy" type="primary" icon={<CopyOutlined />} onClick={copyBatchDraft}>
            Copy to Clipboard
          </Button>,
        ]}
      >
        <div style={{ marginBottom: 12 }}>
          <Text strong>To: </Text>
          <Text copyable style={{ wordBreak: "break-all" }}>{batchDraftEmails}</Text>
        </div>
        <Input.TextArea
          value={batchDraftText}
          onChange={(e) => setBatchDraftText(e.target.value)}
          autoSize={{ minRows: 12, maxRows: 24 }}
          style={{ fontFamily: "inherit", fontSize: 14, lineHeight: "22px" }}
        />
      </Modal>

      {/* Draft Message Modal */}
      <Modal
        title="Draft Introduction Message"
        open={draftVisible}
        onCancel={() => setDraftVisible(false)}
        width={680}
        footer={[
          <Button key="close" onClick={() => setDraftVisible(false)}>
            Close
          </Button>,
          <Button key="copy" type="primary" icon={<CopyOutlined />} onClick={copyDraft}>
            Copy to Clipboard
          </Button>,
        ]}
      >
        <div style={{ marginBottom: 12 }}>
          <Text strong>To: </Text>
          <Text copyable style={{ wordBreak: "break-all" }}>{draftEmails}</Text>
        </div>
        <Input.TextArea
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          autoSize={{ minRows: 12, maxRows: 24 }}
          style={{ fontFamily: "inherit", fontSize: 14, lineHeight: "22px" }}
        />
      </Modal>
    </div>
  );
}
