"use client";

import { useCallback, useEffect, useMemo, useState, Suspense } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  InputNumber,
  Modal,
  Row,
  Segmented,
  Select,
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
import { EmptyState } from "@/components/ops/EmptyState";
import { MemberDetailsDrawer } from "@/components/ops/MemberDetailsDrawer";
import { RemovalReadinessTag } from "@/components/ops/RemovalReadinessTag";
import {
  SlackCommunityFilters,
  filterByDateRange,
  filterBySearch,
  type SlackFilterOptions,
  type SlackFilterState,
} from "@/components/ops/SlackCommunityFilters";
import type { MemberHealthRow } from "@/lib/ops/member-health-types";

type LinkSuggestion = {
  slackUserId: string;
  slackEmail: string;
  slackName: string;
  confidence: "high" | "low";
  kind: string;
};

type LinkRow = {
  airtableRecordId: string;
  name: string;
  primaryEmail: string;
  city: string;
  membership: string;
  payment: string;
  dateJoined: string;
  suggestion: LinkSuggestion | null;
  candidates: Array<{ slackUserId: string; name: string; email: string }>;
};

type RemovalRow = {
  member: MemberHealthRow;
  daysExpired: number | null;
  readiness: string;
  currentChannels: string[];
  lastRemovalAttempt: string | null;
  lastRemovalStatus: string | null;
};

type InviteRow = {
  member: MemberHealthRow;
  cooldownActive: boolean;
  lastInvitedAt: string | null;
  eligibilityReasons: string[];
  deactivated: boolean;
};

type ChannelAddRow = {
  member: MemberHealthRow;
};

type Capabilities = {
  canKickFromChannels: boolean;
  canDeactivateWorkspaceUser: boolean;
  deactivateReason: string;
  canInviteToChannels: boolean;
  inviteToChannelsReason: string;
  canInviteToWorkspace: boolean;
  inviteToWorkspaceReason: string;
  canReactivateUsers: boolean;
  reactivateReason: string;
  scopes: string[];
};

type CompareData = {
  airtable: { recordId: string; fields: Array<{ label: string; value: string }> };
  slack: { fields: Array<{ label: string; value: string }> } | null;
  candidates: Array<{ slackUserId: string; name: string; email: string }>;
  currentSlackEmail: string;
};

const EMPTY_OPTIONS: SlackFilterOptions = { cities: [], memberships: [], payments: [] };
const EMPTY_FILTERS: SlackFilterState = {};

function fmtDate(v: string): string {
  if (!v?.trim()) return "—";
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) return v;
  return new Date(v).toISOString().slice(0, 10);
}

function SlackAccessPageInner() {
  const { message, modal } = App.useApp();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const rawTab = searchParams.get("tab") || "link";
  const tab = rawTab === "remove" || rawTab === "invite" ? rawTab : "link";

  const [mode, setMode] = useState("read_only");
  const [role, setRole] = useState("viewer");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scannedAt, setScannedAt] = useState<string | null>(null);

  const [linkRows, setLinkRows] = useState<LinkRow[]>([]);
  const [linkOptions, setLinkOptions] = useState<SlackFilterOptions>(EMPTY_OPTIONS);
  const [linkFilters, setLinkFilters] = useState<SlackFilterState>(EMPTY_FILTERS);
  const [linkConfidence, setLinkConfidence] = useState<string>("high");
  const [selectedLinks, setSelectedLinks] = useState<Set<string>>(new Set());
  const [busyLinkIds, setBusyLinkIds] = useState<Set<string>>(new Set());

  const [removalRows, setRemovalRows] = useState<RemovalRow[]>([]);
  const [removalFilters, setRemovalFilters] = useState<SlackFilterState>(EMPTY_FILTERS);
  const [removalReadiness, setRemovalReadiness] = useState<string[]>([]);
  const [removalMinDays, setRemovalMinDays] = useState<number | null>(null);
  const [selectedRemoval, setSelectedRemoval] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState(false);

  const [inviteRows, setInviteRows] = useState<InviteRow[]>([]);
  const [channelAddRows, setChannelAddRows] = useState<ChannelAddRow[]>([]);
  const [inviteOptions, setInviteOptions] = useState<SlackFilterOptions>(EMPTY_OPTIONS);
  const [inviteFilters, setInviteFilters] = useState<SlackFilterState>(EMPTY_FILTERS);
  const [inviteView, setInviteView] = useState<"invite" | "channel-add">("invite");
  const [inviteStatus, setInviteStatus] = useState<string>("not_invited");
  const [selectedInvites, setSelectedInvites] = useState<Set<string>>(new Set());
  const [selectedChannelAdds, setSelectedChannelAdds] = useState<Set<string>>(new Set());
  const [inviting, setInviting] = useState(false);
  const [addingChannels, setAddingChannels] = useState(false);
  const [reactivating, setReactivating] = useState(false);

  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [selectedMember, setSelectedMember] = useState<MemberHealthRow | null>(null);

  // Compare modal (tab 1)
  const [compareRow, setCompareRow] = useState<LinkRow | null>(null);
  const [compareData, setCompareData] = useState<CompareData | null>(null);
  const [compareUserId, setCompareUserId] = useState<string | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [linking, setLinking] = useState(false);

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

  const loadLink = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ops-dashboard/slack/link");
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || res.statusText);
      setLinkRows(json.rows || []);
      setLinkOptions(json.options || EMPTY_OPTIONS);
      setCapabilities(json.capabilities || null);
      setScannedAt(json.scannedAt || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadRemoval = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ops-dashboard/slack/removal-queue");
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || res.statusText);
      setRemovalRows(json.rows || []);
      setCapabilities(json.capabilities || null);
      setScannedAt(json.scannedAt || null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadInvite = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ops-dashboard/slack/invite");
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || res.statusText);
      setInviteRows(json.inviteRows || []);
      setChannelAddRows(json.channelAddRows || []);
      setInviteOptions(json.options || EMPTY_OPTIONS);
      setCapabilities(json.capabilities || null);
      setScannedAt(json.scannedAt || null);
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
    if (tab === "link") void loadLink();
    if (tab === "remove") void loadRemoval();
    if (tab === "invite") void loadInvite();
  }, [tab, loadLink, loadRemoval, loadInvite]);

  const reload = () => {
    if (tab === "link") void loadLink();
    if (tab === "remove") void loadRemoval();
    if (tab === "invite") void loadInvite();
  };

  // ---------- Tab 1: linking ----------
  const filteredLinks = useMemo(() => {
    // Only members with a Slack profile suggestion are shown.
    let rows = linkRows.filter((r) => Boolean(r.suggestion));
    rows = filterBySearch(rows, linkFilters.q || "", (r) => [
      r.name,
      r.primaryEmail,
      r.suggestion?.slackName || "",
      r.suggestion?.slackEmail || "",
    ]);
    if (linkFilters.city) {
      const c = linkFilters.city.toLowerCase();
      rows = rows.filter((r) => r.city.toLowerCase() === c);
    }
    if (linkFilters.membership) {
      rows = rows.filter(
        (r) => r.membership.toLowerCase() === linkFilters.membership!.toLowerCase()
      );
    }
    if (linkFilters.payment) {
      rows = rows.filter(
        (r) => r.payment.toLowerCase() === linkFilters.payment!.toLowerCase()
      );
    }
    rows = filterByDateRange(rows, linkFilters.dateFrom, linkFilters.dateTo, (r) => r.dateJoined);
    if (linkConfidence === "high") rows = rows.filter((r) => r.suggestion?.confidence === "high");
    if (linkConfidence === "low") rows = rows.filter((r) => r.suggestion?.confidence === "low");
    return rows;
  }, [linkRows, linkFilters, linkConfidence]);

  const openCompare = async (row: LinkRow) => {
    const userId = row.suggestion?.slackUserId || row.candidates[0]?.slackUserId || null;
    setCompareRow(row);
    setCompareUserId(userId);
    setCompareData(null);
    setCompareLoading(true);
    try {
      const res = await fetch("/api/ops-dashboard/slack/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ airtableRecordId: row.airtableRecordId, slackUserId: userId }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || "Compare failed");
      setCompareData(json);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Compare failed");
    } finally {
      setCompareLoading(false);
    }
  };

  const switchCompareUser = async (userId: string) => {
    if (!compareRow) return;
    setCompareUserId(userId);
    setCompareLoading(true);
    try {
      const res = await fetch("/api/ops-dashboard/slack/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ airtableRecordId: compareRow.airtableRecordId, slackUserId: userId }),
      });
      const json = await res.json();
      if (!res.ok || json.success === false) throw new Error(json.message || "Compare failed");
      setCompareData(json);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Compare failed");
    } finally {
      setCompareLoading(false);
    }
  };

  const updateSlackEmail = async (recordId: string, email: string): Promise<boolean> => {
    if (!canMutate) {
      message.warning("Updating Slack Email requires LIVE mode and admin role");
      return false;
    }
    const res = await fetch("/api/ops-dashboard/slack/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ write: true, updates: [{ airtableRecordId: recordId, suggestedSlackEmail: email }] }),
    });
    const json = await res.json();
    if (!res.ok || json.success === false) {
      message.error(json.message || "Update failed");
      return false;
    }
    if (json.writtenIds?.includes(recordId)) {
      message.success(`Slack Email set to ${email}`);
      return true;
    }
    const skip = json.skipped?.find((s: { id: string }) => s.id === recordId);
    message.warning(`Skipped: ${skip?.reason || "unknown reason"}`);
    return false;
  };

  const linkSingle = async (row: LinkRow) => {
    if (!row.suggestion) return;
    setBusyLinkIds((s) => new Set(s).add(row.airtableRecordId));
    try {
      const ok = await updateSlackEmail(row.airtableRecordId, row.suggestion.slackEmail);
      if (ok) {
        setCompareRow(null);
        setCompareData(null);
        void loadLink();
      }
    } finally {
      setBusyLinkIds((s) => {
        const next = new Set(s);
        next.delete(row.airtableRecordId);
        return next;
      });
    }
  };

  const linkFromCompare = async () => {
    if (!compareRow || !compareData) return;
    const email = compareData.slack?.fields.find((f) => f.label === "Email")?.value || "";
    if (!email || email === "—") {
      message.error("Selected Slack profile has no email to link");
      return;
    }
    setLinking(true);
    try {
      const ok = await updateSlackEmail(compareRow.airtableRecordId, email);
      if (ok) {
        setCompareRow(null);
        setCompareData(null);
        void loadLink();
      }
    } finally {
      setLinking(false);
    }
  };

  const linkSelected = () => {
    const rows = filteredLinks.filter(
      (r) => r.suggestion && selectedLinks.has(r.airtableRecordId)
    );
    if (rows.length === 0) return;
    modal.confirm({
      title: `Update Slack Email for ${rows.length} member(s)?`,
      content: (
        <div>
          <p>Each member&apos;s Slack Email field will be set to the suggested email:</p>
          <ul style={{ maxHeight: 220, overflow: "auto", paddingLeft: 18 }}>
            {rows.map((r) => (
              <li key={r.airtableRecordId}>
                {r.name} → {r.suggestion!.slackEmail}
              </li>
            ))}
          </ul>
          <p>Rows already filled in Airtable are skipped server-side.</p>
        </div>
      ),
      okText: "Update",
      onOk: async () => {
        let okCount = 0;
        for (const r of rows) {
          const ok = await updateSlackEmail(r.airtableRecordId, r.suggestion!.slackEmail);
          if (ok) okCount++;
        }
        if (okCount > 0) message.success(`Linked ${okCount} member(s)`);
        setSelectedLinks(new Set());
        void loadLink();
      },
    });
  };

  // ---------- Tab 2: removal ----------
  const filteredRemoval = useMemo(() => {
    let rows = removalRows;
    rows = filterBySearch(rows, removalFilters.q || "", (r) => [
      r.member.name,
      r.member.primaryEmail,
    ]);
    if (removalFilters.city) {
      const c = removalFilters.city.toLowerCase();
      rows = rows.filter((r) => r.member.city.toLowerCase() === c);
    }
    if (removalFilters.membership) {
      rows = rows.filter(
        (r) => r.member.membership.toLowerCase() === removalFilters.membership!.toLowerCase()
      );
    }
    if (removalFilters.payment) {
      rows = rows.filter(
        (r) => r.member.payment.toLowerCase() === removalFilters.payment!.toLowerCase()
      );
    }
    rows = filterByDateRange(
      rows,
      removalFilters.dateFrom,
      removalFilters.dateTo,
      (r) => r.member.dateJoined
    );
    if (removalReadiness.length > 0) {
      rows = rows.filter((r) => removalReadiness.includes(r.readiness));
    }
    if (removalMinDays != null) {
      rows = rows.filter((r) => (r.daysExpired ?? -1) >= (removalMinDays ?? 0));
    }
    return rows;
  }, [removalRows, removalFilters, removalReadiness, removalMinDays]);

  const runRemoval = (ids: string[]) => {
    if (!canMutate) {
      message.warning("Removal requires LIVE mode and admin role");
      return;
    }
    if (ids.length === 0) return;
    modal.confirm({
      title: `Remove ${ids.length} member(s) from Slack?`,
      content: (
        <div>
          <p>Each member is revalidated server-side before any action:</p>
          <ul style={{ paddingLeft: 18 }}>
            <li>Kicked from their WLTH channels (city + all-members)</li>
            {capabilities?.canDeactivateWorkspaceUser ? (
              <li>Workspace account deactivated (admin token available)</li>
            ) : (
              <li>
                Workspace deactivation unavailable — kick only. Open Slack Admin to
                deactivate accounts manually.
              </li>
            )}
          </ul>
        </div>
      ),
      okText: "Remove from Slack",
      okButtonProps: { danger: true },
      onOk: async () => {
        setRemoving(true);
        try {
          const res = await fetch("/api/ops-dashboard/slack/removal", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "remove_and_deactivate", airtableRecordIds: ids }),
          });
          const json = await res.json();
          if (!res.ok || json.success === false) throw new Error(json.message || "Removal failed");
          const results = json.results || [];
          const done = results.filter((r: { ok?: boolean }) => r.ok);
          const failed = results.filter((r: { ok?: boolean }) => !r.ok);
          message.success(`Removed ${done.length} / ${results.length} member(s)`);
          if (failed.length > 0) {
            modal.warning({
              title: `${failed.length} member(s) had problems`,
              content: (
                <ul style={{ maxHeight: 240, overflow: "auto", paddingLeft: 18 }}>
                  {failed.map(
                    (
                      r: { memberName?: string; kickError?: string; deactivateError?: string },
                      i: number
                    ) => (
                      <li key={i}>
                        {r.memberName}: {r.kickError || r.deactivateError || "unknown error"}
                      </li>
                    )
                  )}
                </ul>
              ),
            });
          }
        } catch (e) {
          message.error(e instanceof Error ? e.message : "Removal failed");
        } finally {
          setRemoving(false);
          setSelectedRemoval(new Set());
          void loadRemoval();
        }
      },
    });
  };

  const copySelectedEmails = async () => {
    const emails = filteredRemoval
      .filter(
        (r) =>
          r.member.airtableRecordId && selectedRemoval.has(r.member.airtableRecordId)
      )
      .map((r) => r.member.primaryEmail)
      .filter(Boolean);
    if (emails.length === 0) return;
    try {
      await navigator.clipboard.writeText(emails.join("\n"));
      message.success(`${emails.length} email(s) copied`);
    } catch {
      message.error("Could not copy emails");
    }
  };

  const exportSelectedCsv = () => {
    const rows = filteredRemoval.filter(
      (r) => r.member.airtableRecordId && selectedRemoval.has(r.member.airtableRecordId)
    );
    if (rows.length === 0) return;
    const cell = (v: string | number | null | undefined) =>
      `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      "email,name,city,dateJoined,serviceAccessUntil,daysExpired,readiness,channels",
      ...rows.map((r) =>
        [
          r.member.primaryEmail,
          r.member.name,
          r.member.city,
          r.member.dateJoined,
          r.member.serviceAccessUntil,
          r.daysExpired ?? "",
          r.readiness,
          r.currentChannels.join("; "),
        ]
          .map(cell)
          .join(",")
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "removal-queue.csv";
    a.click();
    URL.revokeObjectURL(a.href);
    message.success(`Exported ${rows.length} row(s) to removal-queue.csv`);
  };

  // ---------- Tab 3: invites ----------
  const filteredInvites = useMemo(() => {
    let rows = inviteRows;
    rows = filterBySearch(rows, inviteFilters.q || "", (r) => [
      r.member.name,
      r.member.primaryEmail,
    ]);
    if (inviteFilters.city) {
      const c = inviteFilters.city.toLowerCase();
      rows = rows.filter((r) => r.member.city.toLowerCase() === c);
    }
    if (inviteFilters.membership) {
      rows = rows.filter(
        (r) => r.member.membership.toLowerCase() === inviteFilters.membership!.toLowerCase()
      );
    }
    if (inviteFilters.payment) {
      rows = rows.filter(
        (r) => r.member.payment.toLowerCase() === inviteFilters.payment!.toLowerCase()
      );
    }
    rows = filterByDateRange(
      rows,
      inviteFilters.dateFrom,
      inviteFilters.dateTo,
      (r) => r.member.dateJoined
    );
    if (inviteStatus === "not_invited") rows = rows.filter((r) => !r.cooldownActive);
    if (inviteStatus === "invited") rows = rows.filter((r) => r.cooldownActive);
    return rows;
  }, [inviteRows, inviteFilters, inviteStatus]);

  const filteredChannelAdds = useMemo(() => {
    let rows = channelAddRows;
    rows = filterBySearch(rows, inviteFilters.q || "", (r) => [
      r.member.name,
      r.member.primaryEmail,
    ]);
    if (inviteFilters.city) {
      const c = inviteFilters.city.toLowerCase();
      rows = rows.filter((r) => r.member.city.toLowerCase() === c);
    }
    if (inviteFilters.membership) {
      rows = rows.filter(
        (r) => r.member.membership.toLowerCase() === inviteFilters.membership!.toLowerCase()
      );
    }
    if (inviteFilters.payment) {
      rows = rows.filter(
        (r) => r.member.payment.toLowerCase() === inviteFilters.payment!.toLowerCase()
      );
    }
    rows = filterByDateRange(
      rows,
      inviteFilters.dateFrom,
      inviteFilters.dateTo,
      (r) => r.member.dateJoined
    );
    return rows;
  }, [channelAddRows, inviteFilters]);

  const sendInvites = (ids: string[], force: boolean) => {
    if (!canMutate) {
      message.warning("Inviting requires LIVE mode and admin role");
      return;
    }
    if (ids.length === 0) return;
    modal.confirm({
      title: `Invite ${ids.length} member(s) to Slack?`,
      content: force ? (
        "Cooldown will be ignored and invite emails re-sent."
      ) : (
        <div>
          <p>Each member receives the Slack joining email (workspace link + channel guidance).</p>
          {capabilities?.canInviteToWorkspace ? (
            <p>Workspace invites are sent directly through the Slack admin API.</p>
          ) : (
            <p>
              Open channels are joinable by everyone in the workspace. Once a member joins,
              use the &quot;Add to city channel&quot; view to invite them into their private
              city channel.
            </p>
          )}
        </div>
      ),
      okText: force ? "Force invite" : "Invite",
      onOk: async () => {
        setInviting(true);
        try {
          const res = await fetch("/api/ops-dashboard/slack-email/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ airtableRecordIds: ids, force }),
          });
          const json = await res.json();
          if (!res.ok || json.success === false) throw new Error(json.message || "Invite failed");
          const skipped = json.skippedCount || 0;
          if (json.sentCount > 0) message.success(`Invited ${json.sentCount} member(s)`);
          if (skipped > 0) {
            message.warning(`${skipped} skipped (cooldown or validation)`);
          }
          if (json.failedCount > 0) message.error(`${json.failedCount} failed to send`);
        } catch (e) {
          message.error(e instanceof Error ? e.message : "Invite failed");
        } finally {
          setInviting(false);
          setSelectedInvites(new Set());
          void loadInvite();
        }
      },
    });
  };

  const addToChannels = (ids: string[]) => {
    if (!canMutate) {
      message.warning("Adding to channels requires LIVE mode and admin role");
      return;
    }
    if (ids.length === 0) return;
    modal.confirm({
      title: `Add ${ids.length} member(s) to their city channel?`,
      content: (
        <div>
          <p>Each member is revalidated first (current access + workspace identity).</p>
          {!capabilities?.canInviteToChannels && (
            <Typography.Paragraph type="warning">
              {capabilities?.inviteToChannelsReason}
            </Typography.Paragraph>
          )}
        </div>
      ),
      okText: "Add to channels",
      onOk: async () => {
        setAddingChannels(true);
        try {
          const res = await fetch("/api/ops-dashboard/slack/channel-invite", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ airtableRecordIds: ids }),
          });
          const json = await res.json();
          if (!res.ok || json.success === false) throw new Error(json.message || "Add failed");
          if (json.completed > 0) message.success(`Added ${json.completed} member(s)`);
          if (json.failed > 0) message.error(`${json.failed} failed`);
          if (json.skipped > 0) message.warning(`${json.skipped} skipped`);
        } catch (e) {
          message.error(e instanceof Error ? e.message : "Add failed");
        } finally {
          setAddingChannels(false);
          setSelectedChannelAdds(new Set());
          void loadInvite();
        }
      },
    });
  };

  const reactivateMember = (recordId: string, name: string) => {
    if (!canMutate) {
      message.warning("Reactivating requires LIVE mode and admin role");
      return;
    }
    modal.confirm({
      title: `Reactivate ${name} in Slack?`,
      content: (
        <div>
          <p>Their Slack account is deactivated but still exists in the workspace.</p>
          <p>
            Reactivation restores sign-in and memberships. After reactivating, add them
            back to #introductions and their private city channel from the
            &quot;Add to city channel&quot; view.
          </p>
        </div>
      ),
      okText: "Reactivate",
      onOk: async () => {
        setReactivating(true);
        try {
          const res = await fetch("/api/ops-dashboard/slack/reactivate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ airtableRecordIds: [recordId] }),
          });
          const json = await res.json();
          if (!res.ok || json.success === false) throw new Error(json.message || "Reactivate failed");
          const result = json.results?.[0];
          if (result?.status === "completed") {
            message.success(`${name} reactivated in Slack`);
          } else {
            message.error(`${name}: ${result?.error || "reactivation failed"}`);
          }
        } catch (e) {
          message.error(e instanceof Error ? e.message : "Reactivate failed");
        } finally {
          setReactivating(false);
          void loadInvite();
        }
      },
    });
  };

  const capabilityChecks = useMemo(() => {
    if (!capabilities) return [];
    return [
      {
        key: "kick",
        label: "Remove from WLTH channels",
        ok: capabilities.canKickFromChannels,
        reason: "Bot needs channels:write / groups:write and membership in target channels.",
      },
      {
        key: "channel_invite",
        label: "Add members to private city channels",
        ok: capabilities.canInviteToChannels,
        reason: capabilities.inviteToChannelsReason,
      },
      {
        key: "workspace_invite",
        label: "Workspace invite via Slack API",
        ok: capabilities.canInviteToWorkspace,
        reason: capabilities.inviteToWorkspaceReason,
      },
      {
        key: "deactivate",
        label: "Deactivate / reactivate workspace accounts",
        ok: capabilities.canDeactivateWorkspaceUser,
        reason: capabilities.deactivateReason,
      },
    ];
  }, [capabilities]);

  const linkTabExtra = (
    <Segmented
      options={[
        { label: "High confidence", value: "high" },
        { label: "Low confidence", value: "low" },
      ]}
      value={linkConfidence}
      onChange={(v) => setLinkConfidence(String(v))}
    />
  );

  const removalTabExtra = (
    <Space wrap>
      <Select
        mode="multiple"
        allowClear
        placeholder="Readiness"
        style={{ minWidth: 200 }}
        value={removalReadiness}
        onChange={setRemovalReadiness}
        options={[
          "ready_for_review",
          "access_date_invalid",
          "slack_identity_unresolved",
          "no_longer_in_wlth_channels",
          "removal_partially_completed",
          "removal_failed",
        ].map((r) => ({ value: r, label: r.replace(/_/g, " ") }))}
      />
      <InputNumber
        min={0}
        placeholder="Min days expired"
        value={removalMinDays}
        onChange={(v) => setRemovalMinDays(typeof v === "number" ? v : null)}
        style={{ width: 150 }}
      />
    </Space>
  );

  const inviteTabExtra = (
    <Segmented
      options={[
        { label: "Not invited", value: "not_invited" },
        { label: "Invited recently", value: "invited" },
      ]}
      value={inviteStatus}
      onChange={(v) => setInviteStatus(String(v))}
    />
  );

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <OpsPageHeader
        title="Slack Community"
        description="Link Slack identities, remove inactive members, and invite members into the community."
        breadcrumbs={[
          { title: "Members", href: "/members" },
          { title: "Slack Community" },
        ]}
        mode={mode}
        scannedAt={scannedAt}
        onRefresh={reload}
        refreshing={loading}
      />

      {error && <ErrorState message={error} onRetry={reload} />}

      {capabilityChecks.length > 0 && (
        <Alert
          closable
          type={capabilityChecks.some((c) => !c.ok) ? "warning" : "info"}
          showIcon
          style={{ marginBottom: 16 }}
          message="Slack capabilities"
          description={
            <Space direction="vertical" size={2}>
              {capabilityChecks.map((c) => (
                <Typography.Text key={c.key} style={{ fontSize: 13 }}>
                  {c.ok ? "✓" : "✗"} {c.label}
                  {!c.ok && (
                    <Typography.Text type="secondary">
                      {" "}— {c.reason}
                    </Typography.Text>
                  )}
                </Typography.Text>
              ))}
              <Typography.Link
                href="https://wlth-wlks.slack.com/admin"
                target="_blank"
                rel="noreferrer"
              >
                Open Slack Admin
              </Typography.Link>
            </Space>
          }
        />
      )}

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "link",
            label: `Link Slack emails (${linkRows.filter((r) => r.suggestion).length})`,
            children: (
              <>
                <SlackCommunityFilters
                  value={linkFilters}
                  options={linkOptions}
                  onChange={setLinkFilters}
                  onClear={() => setLinkFilters(EMPTY_FILTERS)}
                  extra={linkTabExtra}
                />
                <Space wrap style={{ marginBottom: 12 }}>
                  <Button
                    type="primary"
                    disabled={!canMutate || selectedLinks.size === 0}
                    onClick={linkSelected}
                  >
                    Update selected ({selectedLinks.size})
                  </Button>
                  <Typography.Text type="secondary">
                    Members whose email is not found in Slack — matched by name and other
                    profile data. Only members currently being serviced are listed. Use
                    Compare to review before linking.
                  </Typography.Text>
                </Space>
                <Table
                  size="small"
                  loading={loading}
                  rowKey={(r) => r.airtableRecordId}
                  dataSource={filteredLinks}
                  rowSelection={{
                    selectedRowKeys: [...selectedLinks],
                    onChange: (keys) => setSelectedLinks(new Set(keys.map(String))),
                    getCheckboxProps: (r) => ({ disabled: !r.suggestion }),
                  }}
                  scroll={{ x: 1100 }}
                  locale={{
                    emptyText: (
                      <EmptyState
                        title="No members to link"
                        description="No members with a suggested Slack profile match the current filters."
                      />
                    ),
                  }}
                  columns={[
                    { title: "Name", dataIndex: "name", fixed: "left", width: 160 },
                    { title: "Email", dataIndex: "primaryEmail", width: 200 },
                    { title: "City", dataIndex: "city", width: 110 },
                    { title: "Membership", dataIndex: "membership", width: 110 },
                    { title: "Payment", dataIndex: "payment", width: 100 },
                    {
                      title: "Date joined",
                      dataIndex: "dateJoined",
                      width: 110,
                      render: (v: string) => fmtDate(v),
                    },
                    {
                      title: "Suggested Slack profile",
                      width: 260,
                      render: (_, r) =>
                        r.suggestion ? (
                          <Space direction="vertical" size={0}>
                            <Space size={4}>
                              <Typography.Text strong>
                                {r.suggestion.slackName}
                              </Typography.Text>
                              <Tag color={r.suggestion.confidence === "high" ? "success" : "warning"}>
                                {r.suggestion.confidence}
                              </Tag>
                            </Space>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {r.suggestion.slackEmail}
                            </Typography.Text>
                          </Space>
                        ) : (
                          <Tag>No suggestion</Tag>
                        ),
                    },
                    {
                      title: "Actions",
                      width: 220,
                      render: (_, r) => (
                        <Space>
                          <Button size="small" onClick={() => void openCompare(r)}>
                            Compare
                          </Button>
                          {r.suggestion && (
                            <Button
                              size="small"
                              type="primary"
                              disabled={!canMutate}
                              loading={busyLinkIds.has(r.airtableRecordId)}
                              onClick={() => void linkSingle(r)}
                            >
                              Link
                            </Button>
                          )}
                        </Space>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "remove",
            label: `Remove inactive (${removalRows.length})`,
            children: (
              <>
                <SlackCommunityFilters
                  value={removalFilters}
                  options={{
                    cities: [...new Set(removalRows.map((r) => r.member.city).filter(Boolean))].sort(),
                    memberships: [...new Set(removalRows.map((r) => r.member.membership).filter(Boolean))].sort(),
                    payments: [...new Set(removalRows.map((r) => r.member.payment).filter(Boolean))].sort(),
                  }}
                  onChange={setRemovalFilters}
                  onClear={() => setRemovalFilters(EMPTY_FILTERS)}
                  extra={removalTabExtra}
                />
                <Space wrap style={{ marginBottom: 12 }}>
                  <Button
                    danger
                    type="primary"
                    disabled={!canMutate || selectedRemoval.size === 0}
                    loading={removing}
                    onClick={() => void runRemoval([...selectedRemoval])}
                  >
                    Remove selected from Slack ({selectedRemoval.size})
                  </Button>
                  <Button
                    disabled={selectedRemoval.size === 0}
                    onClick={() => void copySelectedEmails()}
                  >
                    Copy selected emails
                  </Button>
                  <Button
                    disabled={selectedRemoval.size === 0}
                    onClick={exportSelectedCsv}
                  >
                    Export selected CSV
                  </Button>
                  <Button
                    href="https://wlth-wlks.slack.com/admin"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Slack Admin
                  </Button>
                  <Typography.Text type="secondary">
                    Expired access, not paused — paused members stay in the community.
                  </Typography.Text>
                </Space>
                <Table
                  size="small"
                  loading={loading}
                  rowKey={(r) => r.member.airtableRecordId || r.member.primaryEmail}
                  dataSource={filteredRemoval}
                  rowSelection={{
                    selectedRowKeys: [...selectedRemoval],
                    onChange: (keys) => setSelectedRemoval(new Set(keys.map(String))),
                    getCheckboxProps: (r) => ({
                      disabled:
                        r.readiness === "still_has_access" ||
                        r.readiness === "already_deactivated",
                    }),
                  }}
                  onRow={(r) => ({
                    onClick: () => setSelectedMember(r.member),
                    style: { cursor: "pointer" },
                  })}
                  scroll={{ x: 1300 }}
                  locale={{
                    emptyText: (
                      <EmptyState
                        title="No inactive members"
                        description="No expired members left in Slack, or filters exclude them."
                      />
                    ),
                  }}
                  columns={[
                    { title: "Name", render: (_, r) => r.member.name, fixed: "left", width: 150 },
                    { title: "Email", render: (_, r) => r.member.primaryEmail, width: 200 },
                    { title: "City", render: (_, r) => r.member.city, width: 100 },
                    {
                      title: "Date joined",
                      render: (_, r) => fmtDate(r.member.dateJoined),
                      width: 110,
                    },
                    {
                      title: "Access until",
                      render: (_, r) => r.member.serviceAccessUntil || "—",
                      width: 110,
                    },
                    {
                      title: "Days expired",
                      render: (_, r) => r.daysExpired ?? "—",
                      width: 100,
                    },
                    {
                      title: "Channels",
                      render: (_, r) => r.currentChannels.join(", ") || "—",
                      width: 180,
                    },
                    {
                      title: "Readiness",
                      render: (_, r) => <RemovalReadinessTag readiness={r.readiness} />,
                      width: 150,
                    },
                    {
                      title: "Last attempt",
                      render: (_, r) =>
                        r.lastRemovalAttempt
                          ? `${r.lastRemovalStatus} @ ${fmtDate(r.lastRemovalAttempt)}`
                          : "—",
                      width: 150,
                    },
                    {
                      title: "Action",
                      width: 120,
                      render: (_, r) => (
                        <Button
                          size="small"
                          danger
                          disabled={!canMutate || removing}
                          onClick={(e) => {
                            e.stopPropagation();
                            void runRemoval([r.member.airtableRecordId || r.member.primaryEmail]);
                          }}
                        >
                          Remove
                        </Button>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "invite",
            label: `Invite to Slack (${inviteRows.length})`,
            children: (
              <>
                <SlackCommunityFilters
                  value={inviteFilters}
                  options={inviteOptions}
                  onChange={setInviteFilters}
                  onClear={() => setInviteFilters(EMPTY_FILTERS)}
                  extra={
                    <Space wrap>
                      {inviteView === "invite" && inviteTabExtra}
                      <Segmented
                        options={[
                          { label: `To invite (${inviteRows.length})`, value: "invite" },
                          {
                            label: `Add to city channel (${channelAddRows.length})`,
                            value: "channel-add",
                          },
                        ]}
                        value={inviteView}
                        onChange={(v) => setInviteView(String(v) as "invite" | "channel-add")}
                      />
                    </Space>
                  }
                />

                {inviteView === "invite" ? (
                  <>
                    <Space wrap style={{ marginBottom: 12 }}>
                      <Button
                        type="primary"
                        disabled={!canMutate || selectedInvites.size === 0}
                        loading={inviting}
                        onClick={() => void sendInvites([...selectedInvites], false)}
                      >
                        Invite selected ({selectedInvites.size})
                      </Button>
                      <Button
                        disabled={!canMutate || selectedInvites.size === 0}
                        loading={inviting}
                        onClick={() => void sendInvites([...selectedInvites], true)}
                      >
                        Force invite selected
                      </Button>
                      <Typography.Text type="secondary">
                        Invite email with the workspace join link. Open channels are joinable
                        by everyone; we handle the private city channel.
                      </Typography.Text>
                    </Space>
                    <Table
                      size="small"
                      loading={loading}
                      rowKey={(r) => r.member.airtableRecordId || r.member.primaryEmail}
                      dataSource={filteredInvites}
                      rowSelection={{
                        selectedRowKeys: [...selectedInvites],
                        onChange: (keys) => setSelectedInvites(new Set(keys.map(String))),
                        getCheckboxProps: (r) => ({
                          disabled: r.eligibilityReasons.length > 0 || r.deactivated,
                        }),
                      }}
                      onRow={(r) => ({
                        onClick: () => setSelectedMember(r.member),
                        style: { cursor: "pointer" },
                      })}
                      scroll={{ x: 1200 }}
                      locale={{
                        emptyText: (
                          <EmptyState
                            title="No members to invite"
                            description="Everyone with current access is already in Slack, or filters exclude them."
                          />
                        ),
                      }}
                      columns={[
                        { title: "Name", render: (_, r) => r.member.name, fixed: "left", width: 150 },
                        { title: "Email", render: (_, r) => r.member.primaryEmail, width: 200 },
                        { title: "City", render: (_, r) => r.member.city, width: 100 },
                        {
                          title: "City channel",
                          render: (_, r) => r.member.cityChannelName || "—",
                          width: 140,
                        },
                        {
                          title: "Date joined",
                          render: (_, r) => fmtDate(r.member.dateJoined),
                          width: 110,
                        },
                        {
                          title: "Membership",
                          render: (_, r) => r.member.membership,
                          width: 110,
                        },
                        {
                          title: "Status",
                          width: 130,
                          render: (_, r) =>
                            r.deactivated ? (
                              <Tag color="error">Deactivated</Tag>
                            ) : r.cooldownActive ? (
                              <Tag color="processing">
                                Invited {fmtDate(r.lastInvitedAt || "")}
                              </Tag>
                            ) : r.eligibilityReasons.length > 0 ? (
                              <Tag color="warning">Blocked</Tag>
                            ) : (
                              <Tag color="success">Ready</Tag>
                            ),
                        },
                        {
                          title: "Blockers",
                          render: (_, r) =>
                            r.deactivated
                              ? "Slack account deactivated — reactivate to restore community access."
                              : r.eligibilityReasons.length > 0
                                ? r.eligibilityReasons.join("; ")
                                : "—",
                          ellipsis: true,
                        },
                        {
                          title: "Action",
                          width: 170,
                          render: (_, r) =>
                            r.deactivated ? (
                              capabilities?.canReactivateUsers ? (
                                <Button
                                  size="small"
                                  type="primary"
                                  disabled={!canMutate || reactivating}
                                  loading={reactivating}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void reactivateMember(
                                      r.member.airtableRecordId || r.member.primaryEmail,
                                      r.member.name
                                    );
                                  }}
                                >
                                  Reactivate
                                </Button>
                              ) : (
                                <Button
                                  size="small"
                                  href="https://wlth-wlks.slack.com/admin"
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  Open Slack Admin
                                </Button>
                              )
                            ) : (
                              <Space>
                                <Button
                                  size="small"
                                  type="primary"
                                  disabled={
                                    !canMutate ||
                                    inviting ||
                                    r.eligibilityReasons.length > 0 ||
                                    r.cooldownActive
                                  }
                                  loading={inviting}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void sendInvites(
                                      [r.member.airtableRecordId || r.member.primaryEmail],
                                      false
                                    );
                                  }}
                                >
                                  Invite
                                </Button>
                                {r.cooldownActive && r.eligibilityReasons.length === 0 && (
                                  <Button
                                    size="small"
                                    disabled={!canMutate || inviting}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void sendInvites(
                                        [r.member.airtableRecordId || r.member.primaryEmail],
                                        true
                                      );
                                    }}
                                  >
                                    Resend
                                  </Button>
                                )}
                              </Space>
                            ),
                        },
                      ]}
                    />
                  </>
                ) : (
                  <>
                    <Space wrap style={{ marginBottom: 12 }}>
                      <Button
                        type="primary"
                        disabled={
                          !canMutate ||
                          selectedChannelAdds.size === 0 ||
                          !capabilities?.canInviteToChannels
                        }
                        loading={addingChannels}
                        onClick={() => void addToChannels([...selectedChannelAdds])}
                      >
                        Add selected to city channel ({selectedChannelAdds.size})
                      </Button>
                      <Typography.Text type="secondary">
                        In the workspace but missing from their private city channel.
                      </Typography.Text>
                    </Space>
                    <Table
                      size="small"
                      loading={loading}
                      rowKey={(r) => r.member.airtableRecordId || r.member.primaryEmail}
                      dataSource={filteredChannelAdds}
                      rowSelection={{
                        selectedRowKeys: [...selectedChannelAdds],
                        onChange: (keys) => setSelectedChannelAdds(new Set(keys.map(String))),
                      }}
                      onRow={(r) => ({
                        onClick: () => setSelectedMember(r.member),
                        style: { cursor: "pointer" },
                      })}
                      scroll={{ x: 1000 }}
                      locale={{
                        emptyText: (
                          <EmptyState
                            title="No pending channel adds"
                            description="Everyone in the workspace is already in their city channel."
                          />
                        ),
                      }}
                      columns={[
                        { title: "Name", render: (_, r) => r.member.name, fixed: "left", width: 150 },
                        { title: "Email", render: (_, r) => r.member.primaryEmail, width: 200 },
                        { title: "City", render: (_, r) => r.member.city, width: 100 },
                        {
                          title: "City channel",
                          render: (_, r) => r.member.cityChannelName || "—",
                          width: 140,
                        },
                        {
                          title: "Date joined",
                          render: (_, r) => fmtDate(r.member.dateJoined),
                          width: 110,
                        },
                        {
                          title: "Action",
                          width: 170,
                          render: (_, r) => (
                            <Button
                              size="small"
                              type="primary"
                              disabled={!canMutate || !capabilities?.canInviteToChannels}
                              loading={addingChannels}
                              onClick={(e) => {
                                e.stopPropagation();
                                void addToChannels([
                                  r.member.airtableRecordId || r.member.primaryEmail,
                                ]);
                              }}
                            >
                              Add to channel
                            </Button>
                          ),
                        },
                      ]}
                    />
                  </>
                )}
              </>
            ),
          },
        ]}
      />

      <Modal
        open={Boolean(compareRow)}
        onCancel={() => {
          setCompareRow(null);
          setCompareData(null);
        }}
        title={
          compareRow
            ? `Compare Airtable ↔ Slack — ${compareRow.name}`
            : "Compare Airtable ↔ Slack"
        }
        width={860}
        footer={
          <Space>
            <Button
              onClick={() => {
                setCompareRow(null);
                setCompareData(null);
              }}
            >
              Not a match
            </Button>
            <Button
              type="primary"
              disabled={!canMutate || compareLoading || !compareData?.slack}
              loading={linking}
              onClick={() => void linkFromCompare()}
            >
              This is them — update Slack Email
            </Button>
          </Space>
        }
        destroyOnHidden
      >
        <Spin spinning={compareLoading}>
          <Select
            showSearch
            placeholder="Choose a Slack user"
            style={{ width: "100%", marginBottom: 12 }}
            value={compareUserId || undefined}
            onChange={(v) => void switchCompareUser(String(v))}
            optionFilterProp="label"
            options={(compareData?.candidates || []).map((c) => ({
              value: c.slackUserId,
              label: `${c.name} — ${c.email}`,
            }))}
          />
          <Row gutter={12}>
            <Col xs={24} md={12}>
              <Card size="small" title="Airtable record" style={{ height: "100%" }}>
                <Descriptions
                  size="small"
                  column={1}
                  items={(compareData?.airtable.fields || []).map((f) => ({
                    key: f.label,
                    label: f.label,
                    children: f.value,
                  }))}
                />
              </Card>
            </Col>
            <Col xs={24} md={12}>
              <Card size="small" title="Slack profile" style={{ height: "100%" }}>
                {compareData?.slack ? (
                  <Descriptions
                    size="small"
                    column={1}
                    items={compareData.slack.fields.map((f) => ({
                      key: f.label,
                      label: f.label,
                      children: f.value,
                    }))}
                  />
                ) : (
                  <Typography.Text type="secondary">
                    No Slack profile selected or profile unavailable.
                  </Typography.Text>
                )}
              </Card>
            </Col>
          </Row>
        </Spin>
      </Modal>

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
