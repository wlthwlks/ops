"use client";

import { Card, Tag, Typography } from "antd";
import type { IntegrationHealth } from "@/lib/ops/member-health-types";

const { Text } = Typography;

const COLOR: Record<string, string> = {
  healthy: "success",
  warning: "warning",
  error: "error",
  not_configured: "default",
  not_checked: "processing",
};

export function IntegrationHealthCard({ item }: { item: IntegrationHealth }) {
  return (
    <Card size="small" styles={{ body: { padding: 12 } }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <Text strong>{item.name}</Text>
        <Tag color={COLOR[item.status] || "default"}>{item.status.replace(/_/g, " ")}</Tag>
      </div>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {item.configured ? "Configured" : "Not configured"}
        {item.checked ? " · Checked" : " · Not checked"}
      </Text>
      <div style={{ marginTop: 6, fontSize: 12 }}>{item.message}</div>
    </Card>
  );
}
