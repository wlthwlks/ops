/**
 * Browser-safe URL normalizers for Update Details (mirrors server helpers).
 */

export const SOCIAL_PLATFORMS = [
  "linkedin",
  "instagram",
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export type SocialLink = {
  platform: SocialPlatform;
  url: string;
};

export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, string> = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
};

/** Platforms shown in the "+ Add another" picker (LinkedIn first). */
export const ADDABLE_SOCIAL_PLATFORMS: SocialPlatform[] = [
  "linkedin",
  "instagram",
];

const BLOCKED_PROTOCOLS = /^(javascript|data|file|vbscript|blob):/i;

function trimInput(raw: unknown): string {
  return String(raw ?? "").trim();
}

export function normalizeHttpUrl(
  raw: unknown,
  opts?: { fieldLabel?: string; maxLength?: number }
):
  | { ok: true; url: string | "" }
  | { ok: false; message: string } {
  const label = opts?.fieldLabel || "website";
  const maxLength = opts?.maxLength ?? 500;
  const input = trimInput(raw);
  if (!input) return { ok: true, url: "" };

  if (BLOCKED_PROTOCOLS.test(input)) {
    return { ok: false, message: `Please enter a valid ${label}.` };
  }

  let candidate = input;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, message: `Please enter a valid ${label}.` };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    return { ok: false, message: `Please enter a valid ${label}.` };
  }

  parsed.protocol = "https:";

  if (parsed.username || parsed.password) {
    return { ok: false, message: `Please enter a valid ${label}.` };
  }
  const host = parsed.hostname.trim().toLowerCase();
  if (!host || host === "localhost" || !host.includes(".")) {
    return { ok: false, message: `Please enter a valid ${label}.` };
  }
  if (/\s/.test(host) || !/^[a-z0-9.-]+$/i.test(host)) {
    return { ok: false, message: `Please enter a valid ${label}.` };
  }

  parsed.hostname = host;

  let href = parsed.toString();
  if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
    href = href.replace(/\/$/, "");
  }

  if (href.length > maxLength) {
    return { ok: false, message: `${label[0].toUpperCase()}${label.slice(1)} is too long.` };
  }

  return { ok: true, url: href };
}

export function normalizeBusinessWebsite(raw: unknown) {
  return normalizeHttpUrl(raw, { fieldLabel: "business website", maxLength: 500 });
}

type PlatformRule = {
  hosts: string[];
  pathPatterns: RegExp[];
  canonicalHost: string;
  ensureAtUser?: boolean;
};

const PLATFORM_RULES: Record<SocialPlatform, PlatformRule> = {
  linkedin: {
    hosts: ["linkedin.com", "www.linkedin.com"],
    pathPatterns: [/^\/in\/[^/]+/i, /^\/company\/[^/]+/i, /^\/school\/[^/]+/i],
    canonicalHost: "www.linkedin.com",
  },
  instagram: {
    hosts: ["instagram.com", "www.instagram.com"],
    pathPatterns: [/^\/[A-Za-z0-9._]+\/?$/],
    canonicalHost: "www.instagram.com",
  },
};

function hostMatches(hostname: string, allowed: string[]): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, "");
  return allowed.some((a) => {
    const base = a.toLowerCase().replace(/^www\./, "");
    return h === base || h.endsWith(`.${base}`);
  });
}

function friendlyPlatformError(platform: SocialPlatform): string {
  return `Please enter a valid ${SOCIAL_PLATFORM_LABELS[platform]} profile.`;
}

export function normalizeSocialUrl(
  platform: SocialPlatform,
  raw: unknown
): { ok: true; url: string | "" } | { ok: false; message: string } {
  const input = trimInput(raw);
  if (!input) return { ok: true, url: "" };

  const rule = PLATFORM_RULES[platform];
  const base = normalizeHttpUrl(input, {
    fieldLabel: SOCIAL_PLATFORM_LABELS[platform],
    maxLength: 500,
  });
  if (!base.ok) return { ok: false, message: friendlyPlatformError(platform) };
  if (!base.url) return { ok: true, url: "" };

  let parsed: URL;
  try {
    parsed = new URL(base.url);
  } catch {
    return { ok: false, message: friendlyPlatformError(platform) };
  }

  if (!hostMatches(parsed.hostname, rule.hosts)) {
    return { ok: false, message: friendlyPlatformError(platform) };
  }

  if (platform === "instagram") {
    parsed.search = "";
    parsed.hash = "";
  }

  if (rule.ensureAtUser && parsed.pathname !== "/") {
    const segs = parsed.pathname.split("/").filter(Boolean);
    if (segs[0] && !segs[0].startsWith("@")) {
      segs[0] = `@${segs[0]}`;
      parsed.pathname = `/${segs.join("/")}`;
    }
  }

  const pathOk =
    rule.pathPatterns.length === 0 ||
    rule.pathPatterns.some((re) => re.test(parsed.pathname));
  if (!pathOk || parsed.pathname === "/" || parsed.pathname === "") {
    return { ok: false, message: friendlyPlatformError(platform) };
  }

  parsed.protocol = "https:";
  parsed.hostname = rule.canonicalHost;

  let href = parsed.toString();
  if (parsed.pathname !== "/" && href.endsWith("/") && !parsed.search && !parsed.hash) {
    href = href.replace(/\/$/, "");
  }

  return { ok: true, url: href };
}

export function isSocialPlatform(value: string): value is SocialPlatform {
  return (SOCIAL_PLATFORMS as readonly string[]).includes(value);
}

export function findDuplicateSocialPlatforms(
  links: Array<{ platform: string }>
): SocialPlatform | null {
  const seen = new Set<string>();
  for (const link of links) {
    const p = String(link.platform || "").trim().toLowerCase();
    if (!p) continue;
    if (seen.has(p)) return p as SocialPlatform;
    seen.add(p);
  }
  return null;
}

/** Display helper: strip protocol for compact inputs. */
export function displayUrl(url: string): string {
  return String(url || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/$/, "");
}
