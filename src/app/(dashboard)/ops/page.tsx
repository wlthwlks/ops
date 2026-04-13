import { Typography } from "antd";
import { getOpsOverview } from "@/lib/queries";
import { OpsTable } from "./ops-table";

export const dynamic = "force-dynamic";

const { Title } = Typography;

export default function OpsPage() {
  const ops = getOpsOverview();

  return (
    <>
      <Title level={3}>Operations</Title>
      <OpsTable ops={ops} />
    </>
  );
}
