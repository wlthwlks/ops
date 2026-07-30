import { NextResponse } from "next/server";

export function getAllowedWebflowOrigins(): string[] {
  const raw = process.env.WEBFLOW_ALLOWED_ORIGINS || "";
  const defaults = [
    "https://wlthwlks.com",
    "https://www.wlthwlks.com",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ];
  const fromEnv = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...defaults, ...fromEnv])];
}

export function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  const allowed = getAllowedWebflowOrigins();
  if (allowed.includes(origin)) return true;
  // Allow webflow.io staging subdomains when configured with wildcard style entry
  try {
    const u = new URL(origin);
    if (u.hostname.endsWith(".webflow.io") || u.hostname === "webflow.io") {
      return allowed.some((a) => a.includes("webflow.io"));
    }
  } catch {
    return false;
  }
  return false;
}

export function corsHeaders(origin: string | null): HeadersInit {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Memberstack-Token",
    "Access-Control-Max-Age": "86400",
  };
  if (origin && isOriginAllowed(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
  }
  return headers;
}

export function withCors(response: NextResponse, request: Request): NextResponse {
  const origin = request.headers.get("origin");
  const h = corsHeaders(origin);
  for (const [k, v] of Object.entries(h)) {
    response.headers.set(k, v);
  }
  return response;
}

export function optionsCors(request: Request): NextResponse {
  return withCors(new NextResponse(null, { status: 204 }), request);
}
