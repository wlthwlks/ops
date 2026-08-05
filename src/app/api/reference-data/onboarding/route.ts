import { NextResponse } from "next/server";
import { getOnboardingReferenceData } from "@/lib/forms/reference-data";
import { optionsCors, withCors } from "@/lib/forms/cors";

export const runtime = "nodejs";

/** Always serve fresh catalogue (Form enabled / Active can change in Airtable). */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function GET(request: Request) {
  try {
    const body = await getOnboardingReferenceData();
    const res = NextResponse.json({ success: true, ...body });
    res.headers.set("Cache-Control", "no-store, max-age=0");
    return withCors(res, request);
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
