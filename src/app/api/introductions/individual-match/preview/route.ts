import { NextRequest } from "next/server";
import { db } from "@/db";
import { z } from "zod";
import { requireOpsAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createPineconeClient } from "@/lib/integrations/pinecone";
import {
  previewIndividualMatch,
  type IndividualMatchDeps,
} from "@/lib/introduction/individual-match";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const inputSchema = z.object({
  email: z.string().email(),
});

export async function POST(request: NextRequest) {
  try {
    await requireOpsAdmin();
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

    const proposal = await previewIndividualMatch(deps, input.email);
    return jsonOk({ ...proposal }, proposal.success ? 200 : 422);
  } catch (err) {
    return handleOpsApiError(err);
  }
}
