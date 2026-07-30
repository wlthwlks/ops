"use client";

import { Tag, Tooltip } from "antd";
import { EyeOutlined, WarningOutlined } from "@ant-design/icons";

export function RuntimeModeBadge({ mode }: { mode: "read_only" | "live" | string }) {
  if (mode === "live") {
    return (
      <Tooltip title="LIVE mode: dashboard mutations and delivery are enabled for authorised admins.">
        <Tag icon={<WarningOutlined />} color="error" style={{ marginInlineEnd: 0 }}>
          LIVE
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Tooltip title="Read-only mode: scans and previews work; writes and email sends are blocked.">
      <Tag icon={<EyeOutlined />} color="processing" style={{ marginInlineEnd: 0 }}>
        READ ONLY
      </Tag>
    </Tooltip>
  );
}
