import { Typography, Card, Descriptions } from "antd";
import { getOpRuns } from "@/lib/queries";
import { registry } from "@/lib/registry-instance";
import { notFound } from "next/navigation";
import { RunButton } from "../run-button";
import { RunsTable } from "./runs-table";

export const dynamic = "force-dynamic";

const { Title } = Typography;

export default async function OpDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const op = registry.getBySlug(slug);

  if (!op) {
    notFound();
  }

  const runs = await getOpRuns(slug);

  return (
    <>
      <Title level={3}>{op.name}</Title>
      <Card size="small" style={{ marginBottom: 24 }}>
        <Descriptions column={2}>
          <Descriptions.Item label="Slug">{op.slug}</Descriptions.Item>
          <Descriptions.Item label="Schedule">{op.schedule ?? "Manual"}</Descriptions.Item>
          <Descriptions.Item label="Description" span={2}>{op.description}</Descriptions.Item>
        </Descriptions>
        <div style={{ marginTop: 12 }}>
          <RunButton slug={op.slug} />
        </div>
      </Card>
      <Title level={4}>Run History</Title>
      <RunsTable runs={runs} />
    </>
  );
}
