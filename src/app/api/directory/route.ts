import { NextResponse } from "next/server";
import { optionsCors, withCors } from "@/lib/forms/cors";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import { listDirectoryMembers } from "@/lib/forms/airtable/directory";
import { FormsError } from "@/lib/forms/errors";

export const runtime = "nodejs";

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function GET(request: Request) {
  try {
    // Members-only directory.
    await verifyMemberstackToken(extractMemberstackToken(request), request);
    const members = await listDirectoryMembers();
    return withCors(NextResponse.json({ success: true, members }), request);
  } catch (err) {
    if (err instanceof FormsError) {
      return withCors(
        NextResponse.json(
          { success: false, code: err.code, message: err.message },
          { status: err.status }
        ),
        request
      );
    }
    return withCors(
      NextResponse.json(
        {
          success: false,
          code: "INTERNAL_UNEXPECTED_ERROR",
          message: err instanceof Error ? err.message : "Directory load failed",
        },
        { status: 500 }
      ),
      request
    );
  }
}
