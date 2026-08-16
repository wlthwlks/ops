import { NextRequest } from "next/server";
import { db } from "@/db";
import { requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk } from "@/lib/ops/api-response";
import { createAirtableClient } from "@/lib/integrations/airtable";
import { createPineconeClient } from "@/lib/integrations/pinecone";
import {
  runIntroProfileSync,
  type IntroSyncDeps,
} from "@/lib/ops/sync-intro-profiles";
import { z } from "zod";
import { introductionErrorResponse } from "@/lib/introduction/api-errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const inputSchema = z.object({
  city: z.string().min(1).max(80).optional(),
  dryRun: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  try {
    await requireLiveAdmin("introductions/sync-profiles");
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
    if (!process.env.OPENAI_API_KEY) {
      return handleOpsApiError(new Error("Missing OPENAI_API_KEY"));
    }

    const logs: string[] = [];
    const deps: IntroSyncDeps = {
      airtable: createAirtableClient({ apiKey: airtableToken, baseId: airtableBase }),
      pinecone: createPineconeClient({ apiKey: pineconeKey, indexName: pineconeIndex }),
      db,
      log: (message) => logs.push(message),
    };

    const result = await runIntroProfileSync(deps, {
      cityLabel: input.city,
      dryRun: input.dryRun,
    });

    return jsonOk({ ...result, logs }, result.success ? 200 : 500);
  } catch (err) {
    const known = introductionErrorResponse(err);
    if (known) return known;
    return handleOpsApiError(err);
  }
}
