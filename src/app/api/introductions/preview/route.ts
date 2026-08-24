import { NextRequest } from "next/server";
import { db } from "@/db";
import { z } from "zod";
import { requireOpsAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonError, jsonOk } from "@/lib/ops/api-response";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createPineconeClient } from "@/lib/integrations/pinecone";
import {
  runIntroductionPreview,
  type IntroductionPlanDeps,
} from "@/lib/introduction/plan";
import { syncPineconeBeforePlan } from "@/lib/introduction/preplan-sync";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const inputSchema = z.object({
  cityCode: z.string().min(1).max(80),
  cycleDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  deliveryMode: z.enum(["simulation", "provider_test", "canary", "production"]).optional(),
});

export async function POST(request: NextRequest) {
  let operator: { userId: string };
  try {
    operator = await requireOpsAdmin();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const body = await request.json().catch(() => null);
    const input = inputSchema.parse(body ?? {});

    const airtableToken = process.env.AIRTABLE_GET_DATA_TOKEN;
    const airtableBase = process.env.AIRTABLE_BASE_ID;
    const pineconeKey = process.env.PINECONE_API_KEY;
    const pineconeIndex = process.env.PINECONE_INDEX_NAME;

    if (!airtableToken || !airtableBase) {
      return handleOpsApiError(new Error("Missing Airtable credentials"));
    }
    if (!pineconeKey || !pineconeIndex) {
      return handleOpsApiError(new Error("Missing Pinecone credentials"));
    }

    const logs: string[] = [];
    const deps: IntroductionPlanDeps = {
      db,
      log: (message) => logs.push(message),
      airtable: createAirtableClient({ apiKey: airtableToken, baseId: airtableBase }),
      pinecone: createPineconeClient({ apiKey: pineconeKey, indexName: pineconeIndex }),
    };

    // Blocking pre-match sync — guarantee fresh vectors before generating
    // matchings. A failed sync aborts the preview (ops retries).
    const preSync = await syncPineconeBeforePlan(deps);
    if (!preSync.success) {
      return jsonError(
        "PINECONE_SYNC_FAILED",
        `Pinecone sync failed before match generation: ${preSync.summary}`,
        500
      );
    }

    const result = await runIntroductionPreview(deps, {
      cityCode: input.cityCode,
      cycleDate: input.cycleDate,
      deliveryMode: input.deliveryMode,
      createdBy: operator.userId,
    });

    return jsonOk({ ...result, logs }, result.success ? 200 : 500);
  } catch (err) {
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
