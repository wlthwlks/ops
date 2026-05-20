"use client";

import { useState, useCallback } from "react";
import { Button, Card, Collapse, DatePicker, Divider, Empty, Input, Modal, Select, Spin, Tag, Typography, Space, message, Checkbox } from "antd";
import { SearchOutlined, MailOutlined, CheckCircleOutlined, SyncOutlined, SettingOutlined, DownOutlined, UpOutlined, EditOutlined, CopyOutlined, TeamOutlined, CalendarOutlined as CalendarIcon } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";

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
  availability: string;
  priorityTopic: string;
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
  availability: string;
  priorityTopic: string;
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
      <LabelRow label="Availability">
        <Text style={{ fontSize: 13 }}>{String(m.availability || "—")}</Text>
      </LabelRow>
      <LabelRow label="Priority Topic">
        <Text style={{ fontSize: 13 }}>{String(m.priorityTopic || "—")}</Text>
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
    const memberName = String(member.name).split(" ")[0];
    const matchNames = selected.map((m) => String(m.name).split(" ")[0]);

    // Emails
    const emails = [String(member.email), ...selected.map((m) => String(m.email))].join(", ");

    // Overlapping locations — find places that appear in multiple members' nearby lists
    const allLocSets = [member, ...selected].map((m) => {
      const locs = String(m.nearbyLocation || "").split(/\s*[|,]\s*/).map((l) => l.trim()).filter((l) => l.length > 1);
      return new Set(locs);
    });
    // Count how many members share each location
    const locCounts = new Map<string, number>();
    for (const locSet of allLocSets) {
      for (const loc of locSet) {
        locCounts.set(loc, (locCounts.get(loc) ?? 0) + 1);
      }
    }
    // Prefer locations shared by all, then most, take top 3
    const meetingSpots = Array.from(locCounts.entries())
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([loc]) => loc);

    // Overlapping availability days — intersect the searched member + all selected matches
    const allPeople = [member, ...selected];
    const allAvailSets = allPeople.map((m) => {
      const days = String(m.availability || "")
        .split(/\s*,\s*/)
        .map((d) => d.trim())
        .filter((d) => d.length > 0);
      return new Set(days);
    });
    const commonDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].filter((day) =>
      allAvailSets.every((s) => s.has(day))
    );

    // Two similarity reasons
    const reasons: string[] = [];
    const memberStage = String(member.businessStage || "");
    const matchStages = selected.map((m) => String(m.businessStage || ""));
    if (matchStages.some((s) => s === memberStage) && memberStage) {
      reasons.push(`you're at a similar business stage (${memberStage})`);
    }
    const memberInd = String(member.industry || "").toLowerCase();
    const matchInds = selected.map((m) => String(m.industry || "").toLowerCase());
    if (matchInds.some((ind) => ind === memberInd) && memberInd) {
      reasons.push(`you share the same industry (${String(member.industry)})`);
    }
    if (reasons.length < 2) {
      const memberTopic = String(member.priorityTopic || "");
      const matchTopics = selected.map((m) => String(m.priorityTopic || ""));
      if (matchTopics.some((t) => t === memberTopic) && memberTopic) {
        reasons.push(`you're both focused on ${memberTopic.toLowerCase()}`);
      }
    }
    if (reasons.length < 2 && memberLocs.length > 0) {
      reasons.push("you're based in the same area");
    }
    if (reasons.length < 2 && commonDays.length > 0) {
      reasons.push("your availability overlaps well");
    }

    // Format names nicely
    const nameList =
      matchNames.length === 1
        ? matchNames[0]
        : matchNames.slice(0, -1).join(", ") + " and " + matchNames[matchNames.length - 1];

    // Build the message
    const lines: string[] = [];
    lines.push(`Dear ${memberName},`);
    lines.push("");
    lines.push(`Welcome to the community! We've found some great connections for you.`);
    lines.push("");
    lines.push(`We'd love to introduce you to ${nameList} — we noticed some exciting similarities between you${reasons.length > 0 ? ": " + reasons.slice(0, 2).join(", and ") : ""}.`);
    lines.push("");
    if (meetingSpots.length > 0) {
      lines.push(`Here are a few suggested meeting spots near you: ${meetingSpots.join(", ")}.`);
      lines.push("");
    }
    if (commonDays.length > 0) {
      lines.push(`It looks like ${commonDays.join(", ")} ${commonDays.length === 1 ? "works" : "work"} for everyone — would any of those days suit for a first meet?`);
    } else {
      lines.push("Have a look at each other's availability and find a day that works for all of you.");
    }
    lines.push("");
    lines.push("Looking forward to seeing you connect!");
    lines.push("");
    lines.push("Best,");
    lines.push("The WLTH WLKS Team");

    setDraftEmails(emails);
    setDraftText(lines.join("\n"));
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
    const memberName = newMember.name.split(" ")[0];
    const matchNames = selected.map((m) => String(m.name).split(" ")[0]);
    const emails = [newMember.email, ...selected.map((m) => String(m.email))].join(", ");

    // Overlapping locations — find places shared across the new member + selected matches
    const newMemberLocs = String(newMember.profile?.nearbyLocation || "").split(/\s*[|,]\s*/).map((l) => l.trim()).filter((l) => l.length > 1);
    const allLocSets = [new Set(newMemberLocs), ...selected.map((m) => {
      const locs = String(m.nearbyLocation || "").split(/\s*[|,]\s*/).map((l) => l.trim()).filter((l) => l.length > 1);
      return new Set(locs);
    })];
    const locCounts = new Map<string, number>();
    for (const locSet of allLocSets) {
      for (const loc of locSet) {
        locCounts.set(loc, (locCounts.get(loc) ?? 0) + 1);
      }
    }
    const meetingSpots = Array.from(locCounts.entries())
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([loc]) => loc);

    // Intersect the new member's availability + all selected matches
    const newMemberDays = String(newMember.profile?.availability || "").split(/\s*,\s*/).filter((d) => d.length > 0);
    const allAvailSets = [new Set(newMemberDays), ...selected.map((m) => {
      const days = String(m.availability || "").split(/\s*,\s*/).filter((d) => d.length > 0);
      return new Set(days);
    })];
    const commonDays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].filter((day) =>
      allAvailSets.every((s) => s.has(day))
    );

    const reasons: string[] = [];
    const matchStages = selected.map((m) => String(m.businessStage || ""));
    if (matchStages.some((s) => s === newMember.traction) && newMember.traction) {
      reasons.push(`you're at a similar revenue stage`);
    }
    const matchInds = selected.map((m) => String(m.industry || "").toLowerCase());
    if (matchInds.some((ind) => ind === newMember.industry.toLowerCase()) && newMember.industry) {
      reasons.push(`you share the same industry (${newMember.industry})`);
    }
    if (reasons.length < 2 && meetingSpots.length > 0) reasons.push("you're based in the same area");
    if (reasons.length < 2 && commonDays.length > 0) reasons.push("your availability overlaps well");

    const nameList =
      matchNames.length === 1
        ? matchNames[0]
        : matchNames.slice(0, -1).join(", ") + " and " + matchNames[matchNames.length - 1];

    const lines: string[] = [];
    lines.push(`Dear ${memberName},`);
    lines.push("");
    lines.push("Welcome to the community! We've found some great connections for you.");
    lines.push("");
    lines.push(`We'd love to introduce you to ${nameList} — we noticed some exciting similarities between you${reasons.length > 0 ? ": " + reasons.slice(0, 2).join(", and ") : ""}.`);
    lines.push("");
    if (meetingSpots.length > 0) {
      lines.push(`Here are a few suggested meeting spots near you: ${meetingSpots.join(", ")}.`);
      lines.push("");
    }
    if (commonDays.length > 0) {
      lines.push(`It looks like ${commonDays.join(", ")} ${commonDays.length === 1 ? "works" : "work"} for everyone — would any of those days suit for a first meet?`);
    } else {
      lines.push("Have a look at each other's availability and find a day that works for all of you.");
    }
    lines.push("");
    lines.push("Looking forward to seeing you connect!");
    lines.push("");
    lines.push("Best,");
    lines.push("The WLTH WLKS Team");

    setBatchDraftEmails(emails);
    setBatchDraftText(lines.join("\n"));
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
      <Space direction="vertical" size="middle" style={{ width: "100%", marginBottom: 24 }}>
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
      </Space>

      {/* Match Search */}
      <Space direction="vertical" size="middle" style={{ width: "100%", marginBottom: 24 }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>
            Deliver Custom Matching
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
      </Space>

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

      <Space direction="vertical" size="middle" style={{ width: "100%", marginBottom: 24 }}>
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
      </Space>

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
                                  availability: newMember.profile?.availability ?? "",
                                  priorityTopic: newMember.profile?.priorityTopic ?? "",
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
