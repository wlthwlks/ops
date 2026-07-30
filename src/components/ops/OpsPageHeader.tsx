"use client";

import { Breadcrumb, Button, Flex, Space, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import { RuntimeModeBadge } from "./RuntimeModeBadge";
import { DataFreshnessTag } from "./DataFreshnessTag";

const { Title, Text } = Typography;

export function OpsPageHeader(props: {
  title: string;
  description?: string;
  breadcrumbs?: Array<{ title: string; href?: string }>;
  mode?: string;
  scannedAt?: string | null;
  onRefresh?: () => void;
  refreshing?: boolean;
  extra?: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      {props.breadcrumbs && props.breadcrumbs.length > 0 && (
        <Breadcrumb
          style={{ marginBottom: 8 }}
          items={props.breadcrumbs.map((b) => ({
            title: b.href ? <a href={b.href}>{b.title}</a> : b.title,
          }))}
        />
      )}
      <Flex justify="space-between" align="flex-start" wrap="wrap" gap={12}>
        <div>
          <Title level={3} style={{ margin: 0 }}>
            {props.title}
          </Title>
          {props.description && (
            <Text type="secondary" style={{ display: "block", marginTop: 4 }}>
              {props.description}
            </Text>
          )}
        </div>
        <Space wrap>
          {props.mode && <RuntimeModeBadge mode={props.mode} />}
          {props.scannedAt !== undefined && (
            <DataFreshnessTag scannedAt={props.scannedAt} />
          )}
          {props.onRefresh && (
            <Button
              icon={<ReloadOutlined />}
              onClick={props.onRefresh}
              loading={props.refreshing}
            >
              Scan
            </Button>
          )}
          {props.extra}
        </Space>
      </Flex>
    </div>
  );
}
