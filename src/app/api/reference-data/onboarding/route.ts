import { NextResponse } from "next/server";
import { getOnboardingReferenceData } from "@/lib/forms/reference-data";
import { optionsCors, withCors } from "@/lib/forms/cors";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function GET(request: Request) {
  const body = getOnboardingReferenceData();
  return withCors(NextResponse.json({ success: true, ...body }), request);
}
