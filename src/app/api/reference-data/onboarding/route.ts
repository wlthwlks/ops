import { NextResponse } from "next/server";
import { getOnboardingReferenceData } from "@/lib/forms/reference-data";
import { optionsCors, withCors } from "@/lib/forms/cors";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function GET(request: Request) {
  try {
    const body = await getOnboardingReferenceData();
    return withCors(NextResponse.json({ success: true, ...body }), request);
  } catch (err) {
    return withCors(
      NextResponse.json(
        {
          success: false,
          code: "REFERENCE_DATA_UNAVAILABLE",
          message: err instanceof Error ? err.message : "Failed to load reference data",
        },
        { status: 502 }
      ),
      request
    );
  }
}
