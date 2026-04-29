"use client";

import { useEffect, useState } from "react";
import { Button, Card, Empty, Spin, Typography, Space, Statistic } from "antd";
import { RiseOutlined, ReloadOutlined } from "@ant-design/icons";
import { Column } from "@ant-design/charts";

const { Title, Text } = Typography;

interface GrowingCity {
  city: string;
  count: number;
}

interface ApiResponse {
  success: boolean;
  totalUnlistedMembers: number;
  totalListedMembers: number;
  data: GrowingCity[];
}

export default function GrowingCitiesPage() {
  const [loading, setLoading] = useState(true);
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function fetchData() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/growing-cities");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data: ApiResponse = await res.json();
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchData();
  }, []);

  const chartConfig = {
    data: response?.data ?? [],
    xField: "city",
    yField: "count",
    label: {
      text: "count",
      position: "outside" as const,
    },
    axis: {
      x: {
        labelAutoRotate: true,
      },
    },
    style: {
      radiusTopLeft: 4,
      radiusTopRight: 4,
    },
  };

  return (
    <div style={{ maxWidth: 1100 }}>
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        <Space style={{ width: "100%", justifyContent: "space-between" }}>
          <div>
            <Title level={3} style={{ margin: 0 }}>
              See Growing Cities
            </Title>
            <Text type="secondary">
              All-time active &amp; paid members in cities not yet on your tracked list
            </Text>
          </div>
          <Button
            icon={<ReloadOutlined />}
            onClick={fetchData}
            loading={loading}
          >
            Refresh
          </Button>
        </Space>

        {error && (
          <Card>
            <Text type="danger">{error}</Text>
          </Card>
        )}

        {loading ? (
          <div style={{ textAlign: "center", padding: 48 }}>
            <Spin size="large" />
          </div>
        ) : !response?.data.length ? (
          <Empty description="No unlisted cities found" />
        ) : (
          <>
            <Space size="large">
              <Card>
                <Statistic
                  title="Total Active Members in Unlisted Cities"
                  value={response.totalUnlistedMembers}
                  prefix={<RiseOutlined />}
                />
              </Card>
              <Card>
                <Statistic
                  title="Total Active Members in Listed Cities"
                  value={response.totalListedMembers}
                />
              </Card>
              <Card>
                <Statistic
                  title="Unique Cities"
                  value={response.data.length}
                />
              </Card>
            </Space>

            <Card title="Members by City">
              <Column {...chartConfig} height={400} />
            </Card>
          </>
        )}
      </Space>
    </div>
  );
}
