/**
 * Safe URL normalizers for Update Details directory profile fields.
 * Pure helpers — no network I/O.
 */

export const SOCIAL_PLATFORMS = [
  "linkedin",
  "instagram",
  "x",
  "threads",
  "facebook",
  "youtube",
  "tiktok",
  "other",
] as const;

export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

export type SocialLink = {
  platform: SocialPlatform;
  url: string;
};

export const SOCIAL_PLATFORM_LABELS: Record<SocialPlatform, string> = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
  x: "X / Twitter",
  threads: "Threads",
  facebook: "Facebook",
  youtube: "YouTube",
  tiktok: "TikTok",
  other: "Other link",
};

const BLOCKED_PROTOCOLS = /^(javascript|data|file|vbscript|blob):/i;

function trimInput(raw: unknown): string {
  return String(raw ?? "").trim();
}

/** True when value is empty after trim (optional clear). */
export function isBlankOptional(raw: unknown): boolean {
  return trimInput(raw) === "";
}

/**
 * Normalize a general http(s) website URL.
 * Accepts bare domains; rejects unsafe protocols and non-http(s) schemes.
 */
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

  // Force https canonical storage (keep host/path/query/hash intact aside from protocol).
  parsed.protocol = "https:";

  // Reject credentials in URL and empty hosts
  if (parsed.username || parsed.password) {
    return { ok: false, message: `Please enter a valid ${label}.` };
  }
  const host = parsed.hostname.trim().toLowerCase();
  if (!host || host === "localhost" || !host.includes(".")) {
    return { ok: false, message: `Please enter a valid ${label}.` };
  }
  // Basic host shape: labels with dots, no spaces
  if (/\s/.test(host) || !/^[a-z0-9.-]+$/i.test(host)) {
    return { ok: false, message: `Please enter a valid ${label}.` };
  }

  // Normalize hostname casing only; preserve path/query/hash as entered (decoded form from URL).
  parsed.hostname = host;

  let href = parsed.toString();
  // Strip default trailing slash for bare origins only (https://example.com/ → https://example.com)
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
  /** Path must match at least one pattern (after host match). Empty = any non-empty path ok. */
  pathPatterns: RegExp[];
  /** Preferred host used when rewriting. */
  canonicalHost: string;
  /** Ensure leading @ where platform expects it (tiktok/threads). */
  ensureAtUser?: boolean;
};

const PLATFORM_RULES: Record<Exclude<SocialPlatform, "other">, PlatformRule> = {
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
  x: {
    hosts: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
    pathPatterns: [/^\/[A-Za-z0-9_]+\/?$/],
    canonicalHost: "x.com",
  },
  threads: {
    hosts: ["threads.net", "www.threads.net"],
    pathPatterns: [/^\/@?[A-Za-z0-9._]+\/?$/],
    canonicalHost: "www.threads.net",
    ensureAtUser: true,
  },
  facebook: {
    hosts: ["facebook.com", "www.facebook.com", "fb.com", "www.fb.com", "m.facebook.com"],
    pathPatterns: [
      /^\/[A-Za-z0-9.]+\/?$/,
      /^\/profile\.php/i,
      /^\/pages\//i,
      /^\/groups\//i,
    ],
    canonicalHost: "www.facebook.com",
  },
  youtube: {
    hosts: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"],
    pathPatterns: [
      /^\/@[A-Za-z0-9._-]+/i,
      /^\/channel\/[A-Za-z0-9_-]+/i,
      /^\/c\/[A-Za-z0-9._-]+/i,
      /^\/user\/[A-Za-z0-9._-]+/i,
      /^\/[A-Za-z0-9._-]+\/?$/,
    ],
    canonicalHost: "www.youtube.com",
  },
  tiktok: {
    hosts: ["tiktok.com", "www.tiktok.com", "vm.tiktok.com"],
    pathPatterns: [/^\/@?[A-Za-z0-9._]+/i],
    canonicalHost: "www.tiktok.com",
    ensureAtUser: true,
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
  const label = SOCIAL_PLATFORM_LABELS[platform];
  return `Please enter a valid ${label} profile.`;
}

/**
 * Normalize + validate a social profile URL for a chosen platform.
 */
export function normalizeSocialUrl(
  platform: SocialPlatform,
  raw: unknown
): { ok: true; url: string | "" } | { ok: false; message: string } {
  const input = trimInput(raw);
  if (!input) return { ok: true, url: "" };

  if (platform === "other") {
    return normalizeHttpUrl(input, { fieldLabel: "profile link", maxLength: 500 });
  }

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

  let path = parsed.pathname || "/";
  // Strip tracking junk commonly pasted with IG/FB shares
  if (platform === "instagram" || platform === "facebook") {
    parsed.search = "";
    parsed.hash = "";
  }

  if (rule.ensureAtUser && path !== "/") {
    const segs = path.split("/").filter(Boolean);
    if (segs[0] && !segs[0].startsWith("@")) {
      segs[0] = `@${segs[0]}`;
      path = `/${segs.join("/")}`;
      parsed.pathname = path;
    }
  }

  const pathOk =
    rule.pathPatterns.length === 0 ||
    rule.pathPatterns.some((re) => re.test(parsed.pathname));
  if (!pathOk || parsed.pathname === "/" || parsed.pathname === "") {
    return { ok: false, message: friendlyPlatformError(platform) };
  }

  // Canonical host (preserve path/query after cleanup)
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

/** Reject duplicate platforms (except multiple "other" is also rejected for simplicity). */
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

/**
 * Serialize social links for the single Airtable `social media` text field.
 * Format (one per line): platform|https://...
 */
export function serializeSocialMediaField(links: SocialLink[]): string {
  return links
    .filter((l) => l.platform && l.url)
    .map((l) => `${l.platform}|${l.url}`)
    .join("\n");
}

function detectPlatformFromUrl(url: string): SocialPlatform | null {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    const h = u.hostname.toLowerCase().replace(/^www\./, "");
    if (h === "linkedin.com" || h.endsWith(".linkedin.com")) return "linkedin";
    if (h === "instagram.com" || h.endsWith(".instagram.com")) return "instagram";
    if (h === "x.com" || h === "twitter.com" || h.endsWith(".x.com") || h.endsWith(".twitter.com"))
      return "x";
    if (h === "threads.net" || h.endsWith(".threads.net")) return "threads";
    if (
      h === "facebook.com" ||
      h === "fb.com" ||
      h.endsWith(".facebook.com") ||
      h.endsWith(".fb.com")
    )
      return "facebook";
    if (h === "youtube.com" || h === "youtu.be" || h.endsWith(".youtube.com")) return "youtube";
    if (h === "tiktok.com" || h.endsWith(".tiktok.com")) return "tiktok";
    return "other";
  } catch {
    return null;
  }
}

/**
 * Parse Airtable `social media` text into structured links.
 * Supports our canonical `platform|url` lines and legacy freeform values.
 */
export function parseSocialMediaField(raw: unknown): SocialLink[] {
  const text = trimInput(raw);
  if (!text) return [];

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const out: SocialLink[] = [];
  const used = new Set<string>();

  const push = (platform: SocialPlatform, urlRaw: string) => {
    if (used.has(platform)) return;
    const norm = normalizeSocialUrl(platform, urlRaw);
    if (!norm.ok || !norm.url) return;
    used.add(platform);
    out.push({ platform, url: norm.url });
  };

  // Canonical multi-line
  if (lines.some((l) => /^[a-z]+\|https?:\/\//i.test(l))) {
    for (const line of lines) {
      const m = line.match(/^([a-z]+)\|(https?:\/\/\S+)$/i);
      if (!m) continue;
      const platform = m[1].toLowerCase();
      if (!isSocialPlatform(platform)) continue;
      push(platform, m[2]);
    }
    if (out.length) return out;
  }

  // Single URL or handle-ish freeform
  const asUrl = normalizeHttpUrl(text.replace(/^@/, ""));
  if (asUrl.ok && asUrl.url) {
    const detected = detectPlatformFromUrl(asUrl.url);
    if (detected) {
      push(detected, asUrl.url);
      return out;
    }
  }

  // Extract first URL substring
  const urlMatch = text.match(/https?:\/\/[^\s]+/i) || text.match(/(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}\/[^\s]*/i);
  if (urlMatch) {
    const detected = detectPlatformFromUrl(urlMatch[0]);
    if (detected) {
      push(detected, urlMatch[0]);
      return out;
    }
  }

  return out;
}

export function normalizeBusinessName(raw: unknown): string {
  return trimInput(raw).slice(0, 120);
}

export function normalizeProfessionalHeadline(raw: unknown): string {
  return trimInput(raw).slice(0, 80);
}

export function normalizeProfileBio(raw: unknown): string {
  return trimInput(raw).slice(0, 500);
}
