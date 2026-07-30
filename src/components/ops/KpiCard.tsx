"use client";

import { Card, Statistic, Typography } from "antd";
import { useRouter } from "next/navigation";
import { MetricHelpTooltip } from "@/components/ops/MetricHelpTooltip";

const { Text } = Typography;

export function KpiCard(props: {
  title: string;
  value: number | string;
  hint?: string;
  href?: string;
  status?: "default" | "success" | "warning" | "danger";
  tooltip?: string;
}) {
  const router = useRouter();
  const contentStyle =
    props.status === "danger"
      ? { color: "#cf1322" }
      : props.status === "warning"
        ? { color: "#d46b08" }
        : props.status === "success"
          ? { color: "#389e0d" }
          : undefined;

  const titleNode = props.tooltip ? (
    <span>
      {props.title}
      <MetricHelpTooltip title={props.title} content={props.tooltip} />
    </span>
  ) : (
    props.title
  );

  return (
    <Card
      hoverable={Boolean(props.href)}
      size="small"
      onClick={() => props.href && router.push(props.href)}
      styles={{ body: { padding: 16 } }}
    >
      <Statistic
        title={titleNode}
        value={props.value}
        styles={contentStyle ? { content: contentStyle } : undefined}
      />
      {props.hint && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {props.hint}
        </Text>
      )}
    </Card>
  );
}
