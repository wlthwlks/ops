import { describe, it, expect, vi } from "vitest";
import {
  ANIMATION_FILES,
  animationRelativePath,
  type AnimationVariant,
} from "../../../widgets/shared/animations";

vi.mock("@lottiefiles/dotlottie-react", () => ({
  DotLottieReact: (props: { src?: string; loop?: boolean; autoplay?: boolean }) => {
    // lightweight mock for import side-effects
    void props;
    return null;
  },
}));

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

  it("maps profile-loading to Hello asset file", () => {
    expect(ANIMATION_FILES["profile-loading"]).toBe("profile-loading.lottie");
  });

  it("marks profile-updating as missing until asset is added", () => {
    expect(ANIMATION_FILES["profile-updating"]).toBeNull();
    expect(animationRelativePath("profile-updating")).toBeNull();
  });

  it("includes payment-confirmed for post-pay success", () => {
    expect(ANIMATION_FILES["payment-confirmed"]).toBe("payment-confirmed.lottie");
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
