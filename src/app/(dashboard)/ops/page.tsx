import { Typography } from "antd";
import { getOpsOverview } from "@/lib/queries";
import { OpsTable } from "./ops-table";

export const dynamic = "force-dynamic";

const { Title } = Typography;

export default async function OpsPage() {
  const ops = await getOpsOverview();

  return (
    <>
      <Title level={3}>Operations</Title>
      <OpsTable ops={ops} />
    </>
  );
}
