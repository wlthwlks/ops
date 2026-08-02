/**
 * Inlined DotLottie payloads — bundled into signup.js / update-details.js
 * so Webflow embeds never depend on a separate asset request for playback.
 *
 * Files are still emitted under assets/animations/ for optional caching/CDN.
 */

import {
  ANIMATION_FILES,
  type AnimationVariant,
  animationRelativePath,
} from "./animations-meta";

import walking from "./assets/animations/walking-business-woman.lottie";
import paymentVerification from "./assets/animations/payment-verification.lottie";
import paymentConfirmed from "./assets/animations/payment-confirmed.lottie";
import profileLoading from "./assets/animations/profile-loading.lottie";
import profileUpdating from "./assets/animations/profile-updating.lottie";

export type { AnimationVariant };
export {
  ANIMATION_FILES,
  ANIMATION_ASSET_DIR,
  ANIMATION_SOURCE_FILES,
  animationRelativePath,
} from "./animations-meta";

const INLINE: Record<AnimationVariant, ArrayBuffer | null> = {
  walking,
  "payment-verification": paymentVerification,
  "payment-confirmed": paymentConfirmed,
  "profile-loading": profileLoading,
  "profile-updating": profileUpdating,
};

/** Fresh copy each call — WASM may detach the buffer it receives. */
export function getAnimationData(variant: AnimationVariant): ArrayBuffer | null {
  const buf = INLINE[variant];
  if (!buf || buf.byteLength < 32) return null;
  return buf.slice(0);
}

export async function loadAnimationData(
  variant: AnimationVariant
): Promise<ArrayBuffer | null> {
  return getAnimationData(variant);
}

export function prefetchAnimations(): void {
  // Data is already in the bundle — nothing to prefetch.
}

/** Kept for tests / diagnostics */
export function animationAbsoluteUrl(
  variant: AnimationVariant,
  scriptBaseHref?: string | null
): string | null {
  const rel = animationRelativePath(variant);
  if (!rel) return null;
  if (scriptBaseHref) {
    try {
      return new URL(rel.replace(/^\.\//, ""), scriptBaseHref).href;
    } catch {
      return rel;
    }
  }
  return rel;
}
