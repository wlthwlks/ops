/**
 * Server-only operator authorisation for the ops dashboard.
 * Never trust client-supplied role or mode.
 */
import { auth } from "@clerk/nextjs/server";
import {
  getIntroductionsMode,
  type IntroductionsMode,
} from "@/lib/introduction/runtime-mode";

export type OpsRole = "admin" | "viewer" | "none";

export class OpsAuthError extends Error {
  readonly code: string;
  readonly status: number;
  readonly mode?: IntroductionsMode;

  constructor(code: string, message: string, status: number, mode?: IntroductionsMode) {
    super(message);
    this.name = "OpsAuthError";
    this.code = code;
    this.status = status;
    this.mode = mode;
  }
}

function parseIdList(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

export function getOpsAdminUserIds(): Set<string> {
  return parseIdList(process.env.OPS_ADMIN_USER_IDS);
}

export function getOpsViewerUserIds(): Set<string> {
  return parseIdList(process.env.OPS_VIEWER_USER_IDS);
}

/**
 * Resolve role from Clerk user id allowlists.
 * Admins are also viewers. Unknown users → none (fail closed in production).
 * In non-production, if both allowlists are empty, treat authenticated users as admin
 * so local dev keeps working without extra config.
 */
export function resolveOpsRole(userId: string | null | undefined): OpsRole {
  if (!userId) return "none";
  const admins = getOpsAdminUserIds();
  const viewers = getOpsViewerUserIds();
  if (admins.has(userId)) return "admin";
  if (viewers.has(userId)) return "viewer";

  const allowlistsConfigured = admins.size > 0 || viewers.size > 0;
  if (!allowlistsConfigured && process.env.NODE_ENV !== "production") {
    return "admin";
  }
  return "none";
}

export async function getOpsAuthContext(): Promise<{
  userId: string | null;
  role: OpsRole;
  mode: IntroductionsMode;
}> {
  const session = await auth();
  const userId = session.userId ?? null;
  let mode: IntroductionsMode = "read_only";
  try {
    mode = getIntroductionsMode();
  } catch {
    mode = "read_only";
  }
  return {
    userId,
    role: resolveOpsRole(userId),
    mode,
  };
}

export async function requireOpsViewer(): Promise<{
  userId: string;
  role: OpsRole;
  mode: IntroductionsMode;
}> {
  const ctx = await getOpsAuthContext();
  if (!ctx.userId) {
    throw new OpsAuthError("UNAUTHENTICATED", "Authentication required", 401, ctx.mode);
  }
  if (ctx.role === "none") {
    throw new OpsAuthError(
      "FORBIDDEN",
      "Your account is not authorised for the operations dashboard",
      403,
      ctx.mode
    );
  }
  return { userId: ctx.userId, role: ctx.role, mode: ctx.mode };
}

export async function requireOpsAdmin(): Promise<{
  userId: string;
  role: "admin";
  mode: IntroductionsMode;
}> {
  const ctx = await requireOpsViewer();
  if (ctx.role !== "admin") {
    throw new OpsAuthError(
      "FORBIDDEN_ADMIN",
      "Admin operator role required for this action",
      403,
      ctx.mode
    );
  }
  return { userId: ctx.userId, role: "admin", mode: ctx.mode };
}

/** Manual dashboard mutations require live mode + admin. */
export function assertManualActionsLive(mode: IntroductionsMode, action: string): void {
  if (mode !== "live") {
    throw new OpsAuthError(
      "MANUAL_ACTIONS_READ_ONLY",
      `Dashboard is in read-only mode. Action blocked: ${action}`,
      403,
      mode
    );
  }
}

export async function requireLiveAdmin(action: string): Promise<{
  userId: string;
  role: "admin";
  mode: "live";
}> {
  const ctx = await requireOpsAdmin();
  assertManualActionsLive(ctx.mode, action);
  return { userId: ctx.userId, role: "admin", mode: "live" };
}
