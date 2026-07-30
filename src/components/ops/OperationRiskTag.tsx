"use client";

import { Tag } from "antd";
import type { OpRiskLevel } from "@/lib/types";

export function OperationRiskTag(props: { risk?: OpRiskLevel | string }) {
  const r = props.risk || "safe_read";
  const map: Record<string, { color: string; label: string }> = {
    safe_read: { color: "green", label: "Safe read" },
    dry_run: { color: "blue", label: "Dry run" },
    write: { color: "orange", label: "Write" },
    high_risk: { color: "volcano", label: "High risk" },
    destructive: { color: "red", label: "Destructive" },
    cli_only: { color: "default", label: "CLI only" },
    deprecated: { color: "default", label: "Deprecated" },
  };
  const m = map[r] || { color: "default", label: r };
  return <Tag color={m.color}>{m.label}</Tag>;
}
