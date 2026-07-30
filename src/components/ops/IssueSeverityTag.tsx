"use client";

import { Tag } from "antd";
import type { IssueSeverity } from "@/lib/ops/member-health-types";

const MAP: Record<IssueSeverity, { color: string; label: string }> = {
  critical: { color: "error", label: "Critical" },
  high: { color: "orange", label: "High" },
  medium: { color: "gold", label: "Medium" },
  info: { color: "default", label: "Info" },
};

export function IssueSeverityTag({ severity }: { severity: IssueSeverity | null }) {
  if (!severity) return <Tag>None</Tag>;
  const m = MAP[severity];
  return <Tag color={m.color}>{m.label}</Tag>;
}
