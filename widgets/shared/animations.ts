/**
 * Central map of local DotLottie assets for widget loaders.
 * Built files land under each widget v1/assets/animations folder.
 */

export type AnimationVariant =
  | "walking"
  | "payment-verification"
  | "payment-confirmed"
  | "profile-loading"
  | "profile-updating";

/** Filenames under widget build assets/animations */
export const ANIMATION_FILES: Record<AnimationVariant, string | null> = {
  walking: "walking-business-woman.lottie",
  "payment-verification": "payment-verification.lottie",
  "payment-confirmed": "payment-confirmed.lottie",
  "profile-loading": "profile-loading.lottie",
  "profile-updating": "profile-updating.lottie",
};

export const ANIMATION_ASSET_DIR = "assets/animations";

/** Source filenames emitted by the Vite widget build. */
export const ANIMATION_SOURCE_FILES = [
  "walking-business-woman.lottie",
  "payment-verification.lottie",
  "payment-confirmed.lottie",
  "profile-loading.lottie",
  "profile-updating.lottie",
] as const;

export function animationRelativePath(
  variant: AnimationVariant
): string | null {
  const file = ANIMATION_FILES[variant];
  if (!file) return null;
  return `./${ANIMATION_ASSET_DIR}/${file}`;
}

/** Absolute URL for a variant, resolved against the widget script location. */
export function animationAbsoluteUrl(
  variant: AnimationVariant,
  scriptBaseHref?: string | null
): string | null {
  const rel = animationRelativePath(variant);
  if (!rel) return null;
  const base = scriptBaseHref || detectWidgetScriptHref();
  if (!base) {
    // Last resort: page-relative (often wrong on Webflow) — still try
    try {
      return new URL(rel, window.location.href).href;
    } catch {
      return rel;
    }
  }
  try {
    return new URL(rel.replace(/^\.\//, ""), base).href;
  } catch {
    return rel;
  }
}

/** Find the running widget bundle URL (signup.js / update-details.js). */
export function detectWidgetScriptHref(): string | null {
  if (typeof document === "undefined") return null;

  // Classic scripts: available while the IIFE is first evaluating
  try {
    const cur = document.currentScript as HTMLScriptElement | null;
    if (cur?.src && isWidgetScript(cur.src)) return cur.src;
  } catch {
    /* ignore */
  }

  const scripts = Array.from(document.getElementsByTagName("script"));
  // Prefer last match (most recently added embed)
  for (let i = scripts.length - 1; i >= 0; i--) {
    const src = scripts[i]?.src || scripts[i]?.getAttribute("src") || "";
    if (src && isWidgetScript(src)) {
      try {
        return new URL(src, window.location.href).href;
      } catch {
        return src;
      }
    }
  }
  return null;
}

function isWidgetScript(src: string): boolean {
  return (
    src.includes("/widgets/signup/") ||
    src.includes("/widgets/update-details/") ||
    /\/signup\.js(\?|#|$)/.test(src) ||
    /\/update-details\.js(\?|#|$)/.test(src)
  );
}

/** In-memory cache of fetched .lottie bytes (avoids re-download every step). */
const dataCache = new Map<string, ArrayBuffer>();
const inflight = new Map<string, Promise<ArrayBuffer | null>>();

export async function loadAnimationData(
  variant: AnimationVariant
): Promise<ArrayBuffer | null> {
  const url = animationAbsoluteUrl(variant);
  if (!url) return null;
  const hit = dataCache.get(url);
  if (hit) return hit;

  const pending = inflight.get(url);
  if (pending) return pending;

  const job = (async () => {
    try {
      const res = await fetch(url, { credentials: "omit", mode: "cors" });
      if (!res.ok) {
        console.warn(
          `[wlth] Lottie fetch failed variant="${variant}" status=${res.status} url=${url}`
        );
        return null;
      }
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 32) {
        console.warn(
          `[wlth] Lottie too small variant="${variant}" bytes=${buf.byteLength}`
        );
        return null;
      }
      dataCache.set(url, buf);
      return buf;
    } catch (e) {
      console.warn(
        `[wlth] Lottie fetch error variant="${variant}"`,
        e instanceof Error ? e.message : e
      );
      return null;
    } finally {
      inflight.delete(url);
    }
  })();

  inflight.set(url, job);
  return job;
}

/** Warm cache for the common variants so step transitions are instant. */
export function prefetchAnimations(
  variants: AnimationVariant[] = [
    "walking",
    "payment-verification",
    "payment-confirmed",
    "profile-loading",
    "profile-updating",
  ]
): void {
  for (const v of variants) {
    if (ANIMATION_FILES[v]) void loadAnimationData(v);
  }
}
