import { NextRequest } from "next/server";
import { db } from "@/db";
import { z } from "zod";
import { requireOpsViewer, requireLiveAdmin } from "@/lib/ops/auth";
import { handleOpsApiError, jsonOk, jsonError } from "@/lib/ops/api-response";
import { createAirtableClient } from "@/lib/integrations/airtable";
import {
  createBannedPair,
  listBannedPairs,
  BannedPairError,
} from "@/lib/introduction/banned-pairs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireOpsViewer();
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const airtable = createAirtableClient({
      apiKey: process.env.AIRTABLE_GET_DATA_TOKEN!,
      baseId: process.env.AIRTABLE_BASE_ID!,
    });
    const pairs = await listBannedPairs(db, airtable);
    return jsonOk({ pairs });
  } catch (err) {
    return handleOpsApiError(err);
  }
}

const createSchema = z.object({
  emailA: z.string().email(),
  emailB: z.string().email(),
  note: z.string().trim().max(500).nullable().optional(),
});

export async function POST(request: NextRequest) {
  let operator: { userId: string };
  try {
    operator = await requireLiveAdmin("introductions/banned-pairs");
  } catch (err) {
    return handleOpsApiError(err);
  }

  try {
    const body = await request.json().catch(() => null);
    const input = createSchema.parse(body ?? {});

    const airtable = createAirtableClient({
      apiKey: process.env.AIRTABLE_GET_DATA_TOKEN!,
      baseId: process.env.AIRTABLE_BASE_ID!,
    });

    const pair = await createBannedPair(db, airtable, {
      emailA: input.emailA,
      emailB: input.emailB,
      note: input.note ?? null,
      operator: operator.userId,
    });
    return jsonOk({ pair });
  } catch (err) {
    if (err instanceof BannedPairError) {
      return jsonError(err.code, err.message, 422);
    }
    return handleOpsApiError(err);
  }
}
