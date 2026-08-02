import { describe, it, expect } from "vitest";
import {
  ANIMATION_FILES,
  animationRelativePath,
  type AnimationVariant,
} from "../../../widgets/shared/animations-meta";

describe("animation variant mapping", () => {
  it("maps walking to walking-business-woman asset", () => {
    expect(ANIMATION_FILES.walking).toBe("walking-business-woman.lottie");
    expect(animationRelativePath("walking")).toBe(
      "./assets/animations/walking-business-woman.lottie"
    );
  });

  it("maps payment-verification separately from walking", () => {
    expect(ANIMATION_FILES["payment-verification"]).toBe(
      "payment-verification.lottie"
    );
    expect(animationRelativePath("payment-verification")).not.toEqual(
      animationRelativePath("walking")
    );
  });

  it("maps profile-loading and profile-updating", () => {
    expect(ANIMATION_FILES["profile-loading"]).toBe("profile-loading.lottie");
    expect(ANIMATION_FILES["profile-updating"]).toBe("profile-updating.lottie");
  });

  it("includes payment-confirmed for post-pay success", () => {
    expect(ANIMATION_FILES["payment-confirmed"]).toBe(
      "payment-confirmed.lottie"
    );
  });

  it("resolves asset path against widget script href", () => {
    const rel = animationRelativePath("walking")!;
    const abs = new URL(
      rel.replace(/^\.\//, ""),
      "https://ops.wlthwlks.com/widgets/signup/v1/signup.js"
    ).href;
    expect(abs).toBe(
      "https://ops.wlthwlks.com/widgets/signup/v1/assets/animations/walking-business-woman.lottie"
    );
  });

  it("all non-null variants resolve under assets/animations", () => {
    const variants = Object.keys(ANIMATION_FILES) as AnimationVariant[];
    for (const v of variants) {
      const path = animationRelativePath(v);
      if (path) {
        expect(path.startsWith("./assets/animations/")).toBe(true);
        expect(path.endsWith(".lottie")).toBe(true);
      }
    }
  });
});
