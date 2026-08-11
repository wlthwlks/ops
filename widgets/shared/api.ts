/**
 * Shared widget fetch helper — avoid CORS preflight on GETs without body.
 */

export type WidgetApiError = Error & {
  status?: number;
  code?: string;
  details?: unknown;
  reason?: string;
  apiStatus?: string;
  requiresPaymentMethod?: boolean;
  fields?: Record<string, string>;
  body?: Record<string, unknown>;
};

export async function widgetApi(
  base: string,
  path: string,
  opts: RequestInit & { token?: string } = {}
): Promise<unknown> {
  const headers: Record<string, string> = {
    ...((opts.headers as Record<string, string>) || {}),
  };

  const hasJsonBody =
    opts.body != null &&
    opts.body !== "" &&
    !(opts.body instanceof FormData);

  if (hasJsonBody && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }

  if (opts.token) {
    headers["X-Memberstack-Token"] = opts.token;
  }

  const rest: RequestInit = { ...opts };
  delete (rest as { token?: string }).token;
  const res = await fetch(`${base}${path}`, { ...rest, headers });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      (typeof json.message === "string" && json.message.trim()
        ? json.message
        : null) ||
      (typeof json.reason === "string" && json.reason.trim()
        ? json.reason
        : null) ||
      res.statusText ||
      "Request failed";
    const err = new Error(message) as WidgetApiError;
    err.status = res.status;
    err.body = json;
    if (typeof json.code === "string") err.code = json.code;
    if ("details" in json) err.details = json.details;
    if (typeof json.reason === "string") err.reason = json.reason;
    if (typeof json.status === "string") err.apiStatus = json.status;
    if (typeof json.requiresPaymentMethod === "boolean") {
      err.requiresPaymentMethod = json.requiresPaymentMethod;
    }
    // Prefer structured field map when present
    if (json.fields && typeof json.fields === "object" && !Array.isArray(json.fields)) {
      err.fields = json.fields as Record<string, string>;
    }
    throw err;
  }
  return json;
}
