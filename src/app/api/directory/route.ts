import { NextResponse } from "next/server";
import { optionsCors, withCors } from "@/lib/forms/cors";
import {
  extractMemberstackToken,
  verifyMemberstackToken,
} from "@/lib/forms/memberstack/auth";
import {
  listDirectoryMembersPage,
  type DirectoryView,
} from "@/lib/forms/airtable/directory";
import { FormsError } from "@/lib/forms/errors";

export const runtime = "nodejs";

const VIEWS: DirectoryView[] = [
  "recommended",
  "same-city",
  "same-field",
  "same-stage",
  "new",
  "all",
];

export async function OPTIONS(request: Request) {
  return optionsCors(request);
}

export async function GET(request: Request) {
  try {
    const member = await verifyMemberstackToken(
      extractMemberstackToken(request),
      request
    );

    const url = new URL(request.url);
    const rawPage = Number(url.searchParams.get("page")) || 1;
    const rawPageSize = Number(url.searchParams.get("pageSize")) || 12;
    const viewParam = (url.searchParams.get("view") || "recommended").trim();
    const view = (VIEWS as string[]).includes(viewParam)
      ? (viewParam as DirectoryView)
      : "recommended";

    const page = await listDirectoryMembersPage({
      page: rawPage,
      pageSize: rawPageSize,
      q: url.searchParams.get("q") || "",
      city: url.searchParams.get("city") || "",
      field: url.searchParams.get("field") || "",
      view,
      viewerMemberstackId: member.id,
    });

    return withCors(NextResponse.json({ success: true, ...page }), request);
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
