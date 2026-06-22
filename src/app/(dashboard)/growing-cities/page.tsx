"use client";

import { useEffect, useState } from "react";
import { Button, Card, Empty, Spin, Typography, Flex, Statistic } from "antd";
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
  listedCities: GrowingCity[];
}

function tierColor(tier: string): string {
  if (tier === "Top") return "#722ed1";
  if (tier === "Nearly There") return "#52c41a";
  if (tier === "Growing") return "#1890ff";
  return "#faad14";
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

  // Cities with 50+ members — already past the "Nearly There" graduation bar
  const topLargest = (response?.listedCities ?? [])
    .filter((c) => c.count > 50)
    .map((c) => ({ ...c, tier: "Top" }))
    .sort((a, b) => b.count - a.count);

  // Tracked cities 10–50, split into tiers
  const fastestGrowing = (response?.listedCities ?? [])
    .filter((c) => c.count >= 10 && c.count <= 50)
    .map((c) => ({
      ...c,
      tier: c.count >= 40 ? "Nearly There" : c.count >= 25 ? "Growing" : "Emerging",
    }))
    .sort((a, b) => b.count - a.count);

  const nearlyThere = fastestGrowing.filter((c) => c.tier === "Nearly There");
  const growing = fastestGrowing.filter((c) => c.tier === "Growing");
  const emerging = fastestGrowing.filter((c) => c.tier === "Emerging");

  function makeTierChart(data: typeof fastestGrowing, tier: string) {
    return {
      data,
      xField: "city",
      yField: "count",
      label: {
        text: "count",
        position: "outside" as const,
      },
      axis: {
        x: { labelAutoRotate: true },
        y: { title: "Active Members" },
      },
      style: {
        radiusTopLeft: 4,
        radiusTopRight: 4,
        fill: tierColor(tier),
      },
    };
  }

  const unlistedChartConfig = {
    data: response?.data ?? [],
    xField: "city",
    yField: "count",
    label: {
      text: "count",
      position: "outside" as const,
    },
    axis: {
      x: { labelAutoRotate: true },
    },
    style: {
      radiusTopLeft: 4,
      radiusTopRight: 4,
    },
  };

  return (
    <div style={{ maxWidth: 1100 }}>
      <Flex vertical gap="middle" style={{ width: "100%" }}>
        <Flex justify="space-between" align="center">
          <div>
            <Title level={3} style={{ margin: 0 }}>
              See Growing Cities
            </Title>
            <Text type="secondary">
              Track which cities are growing fastest across listed and unlisted cities
            </Text>
          </div>
          <Button
            icon={<ReloadOutlined />}
            onClick={fetchData}
            loading={loading}
          >
            Refresh
          </Button>
        </Flex>

        {error && (
          <Card>
            <Text type="danger">{error}</Text>
          </Card>
        )}

        {loading ? (
          <div style={{ textAlign: "center", padding: 48 }}>
            <Spin size="large" />
          </div>
        ) : !response ? (
          <Empty description="No data" />
        ) : (
          <>
            <Flex gap="large" wrap="wrap">
              <Card>
                <Statistic
                  title="Unlisted City Members"
                  value={response.totalUnlistedMembers}
                  prefix={<RiseOutlined />}
                />
              </Card>
              <Card>
                <Statistic
                  title="Listed City Members"
                  value={response.totalListedMembers}
                />
              </Card>
              <Card>
                <Statistic
                  title="Unlisted Cities"
                  value={response.data.length}
                />
              </Card>
              {fastestGrowing.length > 0 && (
                <Card>
                  <Statistic
                    title="Tracked Cities (10–50)"
                    value={fastestGrowing.length}
                  />
                </Card>
              )}
              {topLargest.length > 0 && (
                <Card>
                  <Statistic
                    title="Top Cities (50+)"
                    value={topLargest.length}
                    valueStyle={{ color: tierColor("Top") }}
                  />
                </Card>
              )}
            </Flex>

            {/* Top Largest Cities — graduated past the 50-member bar */}
            {topLargest.length > 0 && (
              <Card
                title={<Text strong style={{ color: tierColor("Top") }}>Top Largest Cities (50+ members)</Text>}
                size="small"
              >
                <Column {...makeTierChart(topLargest, "Top")} height={320} />
              </Card>
            )}

            {/* Fastest Growing Tracked Cities — split into tier charts */}
            {fastestGrowing.length > 0 && (
              <Flex vertical gap="middle">
                <Title level={4} style={{ margin: 0 }}>
                  Fastest Growing Tracked Cities (10–50 members)
                </Title>

                {nearlyThere.length > 0 && (
                  <Card
                    title={<Text strong style={{ color: tierColor("Nearly There") }}>Nearly There (40–50 members)</Text>}
                    size="small"
                  >
                    <Column {...makeTierChart(nearlyThere, "Nearly There")} height={280} />
                  </Card>
                )}

                {growing.length > 0 && (
                  <Card
                    title={<Text strong style={{ color: tierColor("Growing") }}>Growing (25–39 members)</Text>}
                    size="small"
                  >
                    <Column {...makeTierChart(growing, "Growing")} height={280} />
                  </Card>
                )}

                {emerging.length > 0 && (
                  <Card
                    title={<Text strong style={{ color: tierColor("Emerging") }}>Emerging (10–24 members)</Text>}
                    size="small"
                  >
                    <Column {...makeTierChart(emerging, "Emerging")} height={280} />
                  </Card>
                )}
              </Flex>
            )}

            {response.data.length > 0 && (
              <Card title="Unlisted Cities — Members by City">
                <Column {...unlistedChartConfig} height={400} />
              </Card>
            )}
          </>
        )}
      </Flex>
    </div>
  );
}
