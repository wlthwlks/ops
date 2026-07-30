"use client";

import { Tag } from "antd";

export function RemovalReadinessTag(props: { readiness: string }) {
  const r = props.readiness;
  const map: Record<string, { color: string; label: string }> = {
    ready_for_review: { color: "orange", label: "Ready for review" },
    access_date_invalid: { color: "red", label: "Access date invalid" },
    slack_identity_unresolved: { color: "gold", label: "Slack unresolved" },
    already_deactivated: { color: "default", label: "Already deactivated" },
    no_longer_in_wlth_channels: { color: "blue", label: "No longer in channels" },
    removal_partially_completed: { color: "purple", label: "Partial removal" },
    removal_failed: { color: "error", label: "Removal failed" },
    still_has_access: { color: "green", label: "Still has access" },
  };
  const m = map[r] || { color: "default", label: r };
  return <Tag color={m.color}>{m.label}</Tag>;
}
