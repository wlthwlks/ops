import { ZodError } from "zod";
import { jsonError } from "@/lib/ops/api-response";
import { MatchingProfilesError } from "./profiles";
import { IntroductionSettingsError } from "./settings";

/**
 * Map introduction-engine domain errors to structured API responses.
 * Returns null when the error should fall through to handleOpsApiError.
 */
export function introductionErrorResponse(err: unknown) {
  if (err instanceof ZodError) {
    const details = err.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    return jsonError("INVALID_PAYLOAD", details[0]?.message ?? "Invalid payload", 400, {
      details,
    });
  }
  if (err instanceof MatchingProfilesError || err instanceof IntroductionSettingsError) {
    const status = err.code.endsWith("NOT_FOUND") ? 404 : 422;
    return jsonError(err.code, err.message, status);
  }
  return null;
}
