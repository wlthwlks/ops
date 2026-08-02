/**
 * Central map of local DotLottie assets for widget loaders.
 * Built files land under each widget v1/assets/animations folder.
 *
 * MISSING (not in repo as of 2026-08-02):
 *   profile-updating.lottie — intended "Get things done — Olena"
 *   Until added, that variant uses a CSS-only fallback (no remote URL).
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

export function animationRelativePath(variant: AnimationVariant): string | null {
  const file = ANIMATION_FILES[variant];
  if (!file) return null;
  return `./${ANIMATION_ASSET_DIR}/${file}`;
}

/** Source filenames that must be emitted by the Vite widget build. */
export const ANIMATION_SOURCE_FILES = [
  "walking-business-woman.lottie",
  "payment-verification.lottie",
  "payment-confirmed.lottie",
  "profile-loading.lottie",
] as const;
