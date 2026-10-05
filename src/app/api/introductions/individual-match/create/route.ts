import { NextRequest } from "next/server";
import { db } from "@/db";
import { z } from "zod";
import { requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createPineconeClient } from "@/lib/integrations/pinecone";
import {
  createIndividualMatch,
  type IndividualMatchDeps,
} from "@/lib/introduction/individual-match";
import type { DeliveryMode } from "@/lib/introduction/freeze";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const inputSchema = z.object({
  email: z.string().email(),
  deliveryMode: z
    .enum(["simulation", "provider_test", "canary", "production"])
    .default("production"),
});

export async function POST(request: NextRequest) {
  let operator: { userId: string };
  try {
    operator = await requireLiveAdmin("introductions/individual-match");
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
    if (!airtableToken || !airtableBase || !pineconeKey || !pineconeIndex) {
      return handleOpsApiError(new Error("Missing Airtable/Pinecone credentials"));
    }

    const deps: IndividualMatchDeps = {
      db,
      log: () => {},
      airtable: createAirtableClient({ apiKey: airtableToken, baseId: airtableBase }),
      pinecone: createPineconeClient({ apiKey: pineconeKey, indexName: pineconeIndex }),
    };

    const result = await createIndividualMatch(deps, {
      targetEmail: input.email,
      operator: operator.userId,
      deliveryMode: input.deliveryMode as DeliveryMode,
    });
    return jsonOk({ ...result }, result.proposal.success ? 200 : 422);
  } catch (err) {
    return handleOpsApiError(err);
  }
}
