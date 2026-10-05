import { db } from "@/db";
import { requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { ensureIndividualTemplate } from "@/lib/introduction/templates";

export const dynamic = "force-dynamic";

/**
 * Ensure the individual-introduction email template exists (create + publish
 * a default and wire the global config to it). Returns the template version.
 */
export async function POST() {
  let operator: { userId: string };
  try {
    operator = await requireLiveAdmin("introductions/templates");
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const version = await ensureIndividualTemplate(db, { createdBy: operator.userId });
    return jsonOk({ versionId: version.id, version: version.version, subject: version.subject });
  } catch (err) {
    return handleOpsApiError(err);
  }
}
