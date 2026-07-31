/**
 * Shared widget fetch helper — avoid CORS preflight on GETs without body.
 */

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
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      (json && typeof json === "object" && "message" in json
        ? String((json as { message?: string }).message)
        : null) ||
      res.statusText ||
      "Request failed";
    const err = new Error(message) as Error & {
      status?: number;
      code?: string;
    };
    err.status = res.status;
    if (json && typeof json === "object" && "code" in json) {
      err.code = String((json as { code?: string }).code || "");
    }
    throw err;
  }
  return json;
}
