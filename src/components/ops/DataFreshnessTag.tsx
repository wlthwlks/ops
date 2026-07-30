"use client";

import { Tag, Tooltip } from "antd";
import { ClockCircleOutlined } from "@ant-design/icons";

export function DataFreshnessTag({ scannedAt }: { scannedAt: string | null | undefined }) {
  if (!scannedAt) {
    return (
      <Tag icon={<ClockCircleOutlined />} color="default">
        Not scanned
      </Tag>
    );
  }
  const t = new Date(scannedAt);
  const ageMin = Math.max(0, Math.round((Date.now() - t.getTime()) / 60000));
  const stale = ageMin > 60;
  const label =
    ageMin < 1
      ? "Just now"
      : ageMin < 60
        ? `${ageMin}m ago`
        : `${Math.round(ageMin / 60)}h ago`;
  return (
    <Tooltip title={`Last successful scan: ${t.toISOString()}`}>
      <Tag icon={<ClockCircleOutlined />} color={stale ? "warning" : "success"}>
        {stale ? `Stale · ${label}` : `Fresh · ${label}`}
      </Tag>
    </Tooltip>
  );
}
