/**
 * Animation filenames / paths only (safe to import from vite.config).
 * Binary data lives in animations.ts via inlined .lottie imports.
 */

export type AnimationVariant =
  | "walking"
  | "payment-verification"
  | "payment-confirmed"
  | "profile-loading"
  | "profile-updating";

export const ANIMATION_FILES: Record<AnimationVariant, string | null> = {
  walking: "walking-business-woman.lottie",
  "payment-verification": "payment-verification.lottie",
  "payment-confirmed": "payment-confirmed.lottie",
  "profile-loading": "profile-loading.lottie",
  "profile-updating": "profile-updating.lottie",
};

export const ANIMATION_ASSET_DIR = "assets/animations";

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
