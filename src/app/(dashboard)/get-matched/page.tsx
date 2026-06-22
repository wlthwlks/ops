"use client";

import { useState, useCallback } from "react";
import { Alert, Button, Card, Collapse, DatePicker, Divider, Empty, Flex, Input, Modal, Select, Spin, Table, Tag, Typography, Space, message, Checkbox } from "antd";
import { WarningOutlined } from "@ant-design/icons";
import { SearchOutlined, MailOutlined, CheckCircleOutlined, SyncOutlined, SettingOutlined, DownOutlined, UpOutlined, EditOutlined, CopyOutlined, TeamOutlined, CalendarOutlined as CalendarIcon, SlackOutlined, SendOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { generateMatchMessage } from "@/lib/messaging/generate-match-message";
import { KpiCards } from "./kpi-cards";

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
  const [syncCity, setSyncCity] = useState("All Cities");
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
    postcode: string;
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
    newMemberPostcode: string;
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
    emailPreview: string | null;
    emailsSent: string[];
    emailsFailed: string[];
    error: string | null;
  }
  const [slackDeliveries, setSlackDeliveries] = useState<SlackDelivery[]>([]);
  const [slackSummary, setSlackSummary] = useState<string | null>(null);
  const [slackError, setSlackError] = useState<string | null>(null);
  const [slackLogs, setSlackLogs] = useState<string[]>([]);
  const [slackPreviewed, setSlackPreviewed] = useState(false);
  const [slackEditedMessages, setSlackEditedMessages] = useState<Record<string, string>>({});
  const [slackEditedEmails, setSlackEditedEmails] = useState<Record<string, string>>({});
  const [slackExpandedEmail, setSlackExpandedEmail] = useState<string | null>(null);
  const [emailHtmlExpanded, setEmailHtmlExpanded] = useState<Record<string, boolean>>({});

  // Bumped after a non-preview send completes so the KPI cards refetch and
  // reflect the just-finished batch (Matches sent today, Last send, etc.).
  const [kpiRefreshKey, setKpiRefreshKey] = useState(0);

  // ─── Places diagnostic ───
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const [diagnosticLoading, setDiagnosticLoading] = useState(false);
  const [diagnosticResult, setDiagnosticResult] = useState<{ ok: boolean; verdict: string; nextSteps: string[]; geocoding: any; places: any } | null>(null);

  async function runPlacesDiagnostic() {
    setDiagnosticOpen(true);
    setDiagnosticLoading(true);
    setDiagnosticResult(null);
    try {
      const res = await fetch("/api/diagnose-places");
      const data = await res.json();
      setDiagnosticResult(data);
    } catch (err) {
      setDiagnosticResult({ ok: false, verdict: err instanceof Error ? err.message : "Network error", nextSteps: [], geocoding: {}, places: {} });
    } finally {
      setDiagnosticLoading(false);
    }
  }

  function countMembersMissingNearby(): { missing: number; total: number } {
    let missing = 0;
    let total = 0;
    for (const d of slackDeliveries) {
      total += 1; // the new member
      if (!d.newMemberNearbyLocation || d.newMemberNearbyLocation.trim() === "") missing += 1;
      for (const m of d.matches ?? []) {
        total += 1;
        if (!m.nearbyLocation || m.nearbyLocation.trim() === "") missing += 1;
      }
    }
    return { missing, total };
  }

  async function callMatchIntros(mode: "preview" | "send" | "send-slack" | "send-email") {
    const isPreview = mode === "preview";
    if (isPreview) {
      setSlackLoading(true);
      setSlackPreviewed(false);
      setSlackEditedMessages({});
      setSlackEditedEmails({});
      setEmailHtmlExpanded({});
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
      if (!isPreview) {
        bodyObj.requestId = crypto.randomUUID();
        if (Object.keys(slackEditedMessages).length > 0) {
          bodyObj.editedMessages = slackEditedMessages;
        }
        if (Object.keys(slackEditedEmails).length > 0) {
          bodyObj.editedEmails = slackEditedEmails;
        }
      }
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
        // Populate editable messages from generated previews
        const msgs: Record<string, string> = {};
        const emails: Record<string, string> = {};
        for (const d of data.deliveries || []) {
          if (d.slackMessage) msgs[d.newMemberEmail] = d.slackMessage;
          if (d.emailPreview) emails[d.newMemberEmail] = d.emailPreview;
        }
        setSlackEditedMessages(msgs);
        setSlackEditedEmails(emails);
        setSlackPreviewed(true);
      } else {
        message.success(data.summary);
        setSlackPreviewed(false);
        // Force KPI cards to refetch so the operator sees the just-sent batch
        // reflected in "Matches sent today" / "Last send" without waiting for
        // the next manual refresh.
        setKpiRefreshKey((k) => k + 1);
      }
    } catch (err) {
      setSlackError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSlackLoading(false);
      setSlackSending(false);
    }
  }

  function readyToSendCount(): number {
    return slackDeliveries.filter(
      (d) => !d.error && (d.slackMembersFound.length >= 2 || d.emailPreview)
    ).length;
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
      <KpiCards refreshKey={kpiRefreshKey} />
      <Divider />
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
            <Flex justify="space-between" align="center" gap={12} wrap="wrap">
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
              {slackPreviewed && readyToSendCount() > 0 && (
                <Button
                  type="primary"
                  danger
                  size="large"
                  icon={<SendOutlined />}
                  onClick={() => callMatchIntros("send")}
                  loading={slackSending}
                >
                  {slackSending
                    ? "Sending All..."
                    : `Send All Slack + Email to ${readyToSendCount()} Group${readyToSendCount() === 1 ? "" : "s"}`}
                </Button>
              )}
              {!slackPreviewed && slackDeliveries.some((d) => d.slackSent) && (
                <Tag color="green" style={{ fontSize: 14, padding: "4px 12px" }}>Messages Sent</Tag>
              )}
            </Flex>
          </Card>

          {/* Post-send validation banner — only after a non-preview send. */}
          {!slackPreviewed && slackDeliveries.length > 0 && (() => {
            const total = slackDeliveries.length;
            const slackSent = slackDeliveries.filter((d) => d.slackSent).length;
            const emailsSent = slackDeliveries.reduce((n, d) => n + (d.emailsSent?.length ?? 0), 0);
            const emailsFailed = slackDeliveries.reduce((n, d) => n + (d.emailsFailed?.length ?? 0), 0);
            const withError = slackDeliveries.filter((d) => d.error);
            const allOk = withError.length === 0 && emailsFailed === 0;
            return (
              <Alert
                type={allOk ? "success" : withError.length > 0 ? "error" : "warning"}
                showIcon
                message={
                  allOk
                    ? `All ${total} group${total === 1 ? "" : "s"} delivered`
                    : `${total - withError.length}/${total} delivered · ${withError.length} error${withError.length === 1 ? "" : "s"}${emailsFailed > 0 ? ` · ${emailsFailed} email failure${emailsFailed === 1 ? "" : "s"}` : ""}`
                }
                description={
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    <div>
                      <Text type="secondary">
                        Slack DMs sent: <strong>{slackSent}/{total}</strong> ·{" "}
                        Emails sent: <strong>{emailsSent}</strong>
                        {emailsFailed > 0 ? <> · Emails failed: <strong>{emailsFailed}</strong></> : null}
                      </Text>
                    </div>
                    {withError.length > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <Text strong style={{ fontSize: 12, display: "block", marginBottom: 4 }}>Errors:</Text>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {withError.map((d) => (
                            <li key={d.newMemberEmail}>
                              <Text type="danger">{d.newMemberName}</Text>{" "}
                              <Text type="secondary" style={{ fontSize: 11 }}>({d.newMemberEmail})</Text>{" "}
                              — {d.error}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                }
              />
            );
          })()}

          {(() => {
            const { missing, total } = countMembersMissingNearby();
            if (missing === 0 || total === 0) return null;
            return (
              <Alert
                type="warning"
                showIcon
                icon={<WarningOutlined />}
                message={`${missing} of ${total} members have no nearby-location data`}
                description={
                  <>
                    Their cards will render with an empty "Nearby" field and they're excluded from meeting-spot suggestions in the messages. Most often this means Google Places API (New) isn't enabled or billing has lapsed.{" "}
                    <a onClick={runPlacesDiagnostic} style={{ cursor: "pointer", textDecoration: "underline" }}>Run diagnostic →</a>
                  </>
                }
              />
            );
          })()}

          {[...slackDeliveries]
            .sort((a, b) => {
              const ca = (a.newMemberCity || "").trim();
              const cb = (b.newMemberCity || "").trim();
              // Empty cities sink to the bottom
              if (!ca && cb) return 1;
              if (ca && !cb) return -1;
              // Primary: city A→Z (case-insensitive); secondary: name A→Z
              const cmp = ca.localeCompare(cb, undefined, { sensitivity: "base" });
              if (cmp !== 0) return cmp;
              return (a.newMemberName || "").localeCompare(b.newMemberName || "", undefined, { sensitivity: "base" });
            })
            .map((delivery) => {
            const isExpanded = slackExpandedEmail === delivery.newMemberEmail;
            return (
              <Card
                key={delivery.newMemberEmail}
                size="small"
                style={{
                  borderColor: delivery.slackSent ? "#b7eb8f" : delivery.error ? "#ffccc7" : isExpanded ? "#1890ff" : undefined,
                  cursor: "pointer",
                }}
                onClick={() => setSlackExpandedEmail(isExpanded ? null : delivery.newMemberEmail)}
              >
                {/* Collapsed row header */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <Flex gap={8} align="center" style={{ flex: 1, minWidth: 0 }}>
                    {isExpanded ? <UpOutlined style={{ fontSize: 10, color: "#999" }} /> : <DownOutlined style={{ fontSize: 10, color: "#999" }} />}
                    <Text strong>{delivery.newMemberName}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>{delivery.newMemberEmail}</Text>
                    <Space size={4}>
                      {delivery.newMemberCity && <Tag style={{ margin: 0 }}>{delivery.newMemberCity}</Tag>}
                      {delivery.newMemberIndustry && <Tag style={{ margin: 0 }}>{delivery.newMemberIndustry}</Tag>}
                      {delivery.newMemberTraction && <Tag style={{ margin: 0 }}>{delivery.newMemberTraction}</Tag>}
                    </Space>
                  </Flex>
                  <Flex gap={6} align="center">
                    {delivery.newMemberOnSlack ? <Tag color="blue" style={{ margin: 0 }}><SlackOutlined /> Slack</Tag> : <Tag style={{ margin: 0 }}>Not on Slack</Tag>}
                    {delivery.error && <Tag color="red" style={{ margin: 0 }}>{delivery.error}</Tag>}
                    {delivery.slackSent && <Tag color="green" style={{ margin: 0 }}>Slack Sent</Tag>}
                    {delivery.emailsSent?.length > 0 && <Tag color="green" style={{ margin: 0 }}>{delivery.emailsSent.length} Email(s)</Tag>}
                    {!delivery.slackSent && !delivery.error && slackPreviewed && delivery.slackMembersFound.length >= 2 && (
                      <Tag color="blue" style={{ margin: 0 }}>Ready</Tag>
                    )}
                    <Text type="secondary" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                      {delivery.matches?.length ?? 0} matches | {delivery.slackMembersFound.length}/{delivery.slackMembersFound.length + delivery.slackMembersMissing.length} Slack
                    </Text>
                  </Flex>
                </div>

                {/* Expanded content */}
                {isExpanded && (
                  <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 16 }}>
                    {/* Match cards grid */}
                    {delivery.matches?.length > 0 && (() => {
                      // Group matches by city, preserving original similarity rank.
                      // Sort cities: new member's own city first, then alphabetically.
                      const ranked = delivery.matches.map((m, i) => ({ ...m, originalRank: i + 1 }));
                      const groups = new Map<string, typeof ranked>();
                      for (const m of ranked) {
                        const key = (m.city || "Unknown").trim() || "Unknown";
                        if (!groups.has(key)) groups.set(key, []);
                        groups.get(key)!.push(m);
                      }
                      const ownCity = (delivery.newMemberCity || "").trim();
                      const sortedCityKeys = Array.from(groups.keys()).sort((a, b) => {
                        if (a === ownCity) return -1;
                        if (b === ownCity) return 1;
                        return a.localeCompare(b);
                      });

                      return (
                        <>
                          {/* Being matched card — top row, alone for emphasis */}
                          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12, marginBottom: 16 }}>
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
                                postcode: delivery.newMemberPostcode,
                                city: delivery.newMemberCity,
                                nearbyLocation: delivery.newMemberNearbyLocation,
                                active: true,
                                industry: delivery.newMemberIndustry,
                                traction: delivery.newMemberTraction,
                                hasBusinessDomain: false,
                                businessStage: delivery.newMemberBusinessStage,
                              }} />
                            </Card>
                          </div>

                          {/* City-grouped match cards */}
                          {sortedCityKeys.map((cityKey) => {
                            const cityMatches = groups.get(cityKey)!;
                            const isOwnCity = cityKey === ownCity;
                            return (
                              <div key={cityKey} style={{ marginBottom: 16 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                                  <Text strong style={{ fontSize: 13, color: isOwnCity ? "#52c41a" : "#666" }}>
                                    {cityKey}
                                  </Text>
                                  <Text type="secondary" style={{ fontSize: 12 }}>
                                    {cityMatches.length} match{cityMatches.length === 1 ? "" : "es"}
                                    {isOwnCity ? " · same city" : ""}
                                  </Text>
                                </div>
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
                                  {cityMatches.map((match) => (
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
                                          <Text strong style={{ fontSize: 13 }}>#{match.originalRank} {match.name}</Text>
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
                                        postcode: match.postcode,
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
                              </div>
                            );
                          })}
                        </>
                      );
                    })()}

                    {/* Editable Slack message */}
                    {delivery.slackMessage && slackPreviewed && (
                      <div style={{ marginTop: 12 }}>
                        <Text strong style={{ fontSize: 12, display: "block", marginBottom: 4 }}>
                          <SlackOutlined style={{ marginRight: 4 }} />
                          Slack message (editable):
                        </Text>
                        <Input.TextArea
                          value={slackEditedMessages[delivery.newMemberEmail] ?? delivery.slackMessage}
                          onChange={(e) => setSlackEditedMessages((prev) => ({ ...prev, [delivery.newMemberEmail]: e.target.value }))}
                          autoSize={{ minRows: 6, maxRows: 16 }}
                          style={{ fontFamily: "monospace", fontSize: 12, lineHeight: "18px" }}
                        />
                        <Button
                          type="primary"
                          danger
                          icon={<SendOutlined />}
                          onClick={() => callMatchIntros("send-slack")}
                          loading={slackSending}
                          style={{ marginTop: 8 }}
                        >
                          {slackSending ? "Sending..." : "Approve & Send Slack Message"}
                        </Button>
                      </div>
                    )}
                    {delivery.slackMessage && !slackPreviewed && (
                      <Collapse
                        style={{ marginTop: 12 }}
                        items={[{
                          key: "msg",
                          label: <Text type="secondary" style={{ fontSize: 12 }}>Slack message sent</Text>,
                          children: (
                            <pre style={{ margin: 0, fontSize: 12, lineHeight: "18px", whiteSpace: "pre-wrap", background: "#f5f5f5", padding: 12, borderRadius: 6 }}>
                              {slackEditedMessages[delivery.newMemberEmail] ?? delivery.slackMessage}
                            </pre>
                          ),
                        }]}
                      />
                    )}

                    {/* Email preview + editable HTML */}
                    {delivery.emailPreview && (
                      <div style={{ marginTop: 12 }}>
                        <Flex justify="space-between" align="center" style={{ marginBottom: 4 }}>
                          <Text strong style={{ fontSize: 12 }}>
                            <MailOutlined style={{ marginRight: 4 }} />
                            Email preview{slackPreviewed ? " (editable):" : ":"}
                          </Text>
                          {slackPreviewed && (
                            <a
                              onClick={() =>
                                setEmailHtmlExpanded((prev) => ({
                                  ...prev,
                                  [delivery.newMemberEmail]: !prev[delivery.newMemberEmail],
                                }))
                              }
                              style={{ fontSize: 11, cursor: "pointer" }}
                            >
                              {emailHtmlExpanded[delivery.newMemberEmail] ? <UpOutlined /> : <EditOutlined />}{" "}
                              {emailHtmlExpanded[delivery.newMemberEmail] ? "Hide HTML editor" : "Edit HTML"}
                            </a>
                          )}
                        </Flex>
                        <div
                          style={{ border: "1px solid #f0f0f0", borderRadius: 6, padding: 16, background: "#fff", fontSize: 13, lineHeight: "20px" }}
                          dangerouslySetInnerHTML={{
                            __html: slackEditedEmails[delivery.newMemberEmail] ?? delivery.emailPreview,
                          }}
                        />
                        {slackPreviewed && emailHtmlExpanded[delivery.newMemberEmail] && (
                          <Input.TextArea
                            value={slackEditedEmails[delivery.newMemberEmail] ?? delivery.emailPreview}
                            onChange={(e) =>
                              setSlackEditedEmails((prev) => ({
                                ...prev,
                                [delivery.newMemberEmail]: e.target.value,
                              }))
                            }
                            autoSize={{ minRows: 10, maxRows: 24 }}
                            style={{ fontFamily: "monospace", fontSize: 12, lineHeight: "18px", marginTop: 8 }}
                          />
                        )}
                        {slackPreviewed && (
                          <Button
                            type="primary"
                            icon={<MailOutlined />}
                            onClick={() => callMatchIntros("send-email")}
                            loading={slackSending}
                            style={{ marginTop: 8 }}
                          >
                            {slackSending ? "Sending..." : "Approve & Send Email"}
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}

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

      {/* Places API diagnostic modal */}
      <Modal
        title="Google Places API diagnostic"
        open={diagnosticOpen}
        onCancel={() => setDiagnosticOpen(false)}
        width={760}
        footer={[
          <Button key="rerun" onClick={runPlacesDiagnostic} loading={diagnosticLoading}>Re-run</Button>,
          <Button key="close" type="primary" onClick={() => setDiagnosticOpen(false)}>Close</Button>,
        ]}
      >
        {diagnosticLoading && <div style={{ textAlign: "center", padding: 24 }}><Spin /></div>}
        {!diagnosticLoading && diagnosticResult && (
          <Flex vertical gap={12}>
            <Alert
              type={diagnosticResult.ok ? "success" : "error"}
              showIcon
              message={diagnosticResult.verdict}
              description={diagnosticResult.nextSteps?.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {diagnosticResult.nextSteps.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              ) : null}
            />
            <Collapse
              items={[
                {
                  key: "geo",
                  label: <Text strong>Geocoding API ({String(diagnosticResult.geocoding?.httpStatus ?? "—")})</Text>,
                  children: (
                    <pre style={{ fontSize: 11, lineHeight: "16px", margin: 0, background: "#f5f5f5", padding: 12, borderRadius: 4, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {JSON.stringify(diagnosticResult.geocoding, null, 2)}
                    </pre>
                  ),
                },
                {
                  key: "places",
                  label: <Text strong>Places API New ({String(diagnosticResult.places?.httpStatus ?? "—")})</Text>,
                  children: (
                    <pre style={{ fontSize: 11, lineHeight: "16px", margin: 0, background: "#f5f5f5", padding: 12, borderRadius: 4, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                      {JSON.stringify(diagnosticResult.places, null, 2)}
                    </pre>
                  ),
                },
              ]}
            />
          </Flex>
        )}
      </Modal>

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
