import { getOpsOverview } from "@/lib/queries";
import { OpsTable } from "./ops-table";

export const dynamic = "force-dynamic";

export default async function OpsPage() {
  const ops = await getOpsOverview();

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto" }}>
      <h3 style={{ margin: "0 0 8px", fontSize: 20, fontWeight: 600 }}>
        Operations centre
      </h3>
      <p style={{ margin: "0 0 16px", color: "rgba(0,0,0,0.45)" }}>
        Registered maintenance and diagnostic operations only. No free-text shell
        execution. Write operations require admin + LIVE mode. CLI-only and deprecated
        operations cannot be run from the dashboard.
      </p>
      <OpsTable ops={ops} />
    </div>
  );
}
