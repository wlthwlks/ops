import { getOpRuns } from "@/lib/queries";
import { registry } from "@/lib/registry-instance";
import { notFound } from "next/navigation";
import { RunsTable } from "./runs-table";
import { OpDetailHeader } from "./op-detail-header";

export const dynamic = "force-dynamic";

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
      <OpDetailHeader
        name={op.name}
        description={op.description || ""}
        slug={slug}
        riskLevel={op.riskLevel}
        cliOnly={op.cliOnly || op.riskLevel === "cli_only"}
        commandEquivalent={op.commandEquivalent}
        whenToRun={op.whenToRun}
        whenNotToRun={op.whenNotToRun}
      />
      <RunsTable runs={runs} />
    </>
  );
}
