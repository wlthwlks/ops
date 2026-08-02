import { memo, useEffect, useMemo, useRef, useState } from "react";
import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import {
  type AnimationVariant,
  animationRelativePath,
} from "./animations";

export type AnimatedLoaderSize = "small" | "medium" | "large";

export type AnimatedLoaderProps = {
  variant: AnimationVariant;
  title: string;
  description?: string;
  size?: AnimatedLoaderSize;
  fullScreen?: boolean;
  className?: string;
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(Boolean(mq.matches));
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  }, []);
  return reduced;
}

/** Resolve ./assets/… relative to the widget <script src>. */
function resolveAssetUrl(relPath: string): string {
  if (typeof document === "undefined") return relPath;
  try {
    const scripts = Array.from(document.getElementsByTagName("script"));
    const self = scripts.find((s) => {
      const src = s.getAttribute("src") || "";
      return (
        src.includes("/widgets/signup/") ||
        src.includes("/widgets/update-details/") ||
        /\/signup\.js(\?|$)/.test(src) ||
        /\/update-details\.js(\?|$)/.test(src)
      );
    });
    if (self?.src) {
      return new URL(relPath.replace(/^\.\//, ""), self.src).href;
    }
  } catch {
    /* ignore */
  }
  return relPath;
}

/**
 * Shared animated loader for Signup + Update Details.
 * One Lottie player instance; variant selects the local .lottie asset.
 */
function AnimatedLoaderImpl(props: AnimatedLoaderProps) {
  const {
    variant,
    title,
    description,
    size = "medium",
    fullScreen = false,
    className = "",
  } = props;

  const reducedMotion = usePrefersReducedMotion();
  const [assetFailed, setAssetFailed] = useState(false);
  const failLogged = useRef(false);

  const rel = animationRelativePath(variant);
  const src = useMemo(() => (rel ? resolveAssetUrl(rel) : null), [rel]);

  // Reset failure when variant changes
  useEffect(() => {
    setAssetFailed(false);
    failLogged.current = false;
  }, [variant]);

  const showPlayer = Boolean(src) && !assetFailed;

  return (
    <div
      className={[
        "wlth-animated-loader",
        `wlth-animated-loader--${size}`,
        fullScreen ? "wlth-animated-loader--fullscreen" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="wlth-animated-loader__animation" aria-hidden="true">
        {showPlayer ? (
          <DotLottieReact
            key={variant}
            src={src!}
            loop={!reducedMotion}
            autoplay={!reducedMotion}
            segment={reducedMotion ? [0, 1] : undefined}
            className="wlth-animated-loader__canvas"
            style={{ width: "100%", height: "100%" }}
            renderConfig={{ autoResize: true }}
            dotLottieRefCallback={(inst) => {
              if (!inst) return;
              const onLoadError = () => {
                setAssetFailed(true);
                if (!failLogged.current) {
                  failLogged.current = true;
                  try {
                    console.warn(
                      `[wlth] Lottie failed to load variant="${variant}"`
                    );
                  } catch {
                    /* ignore */
                  }
                }
              };
              try {
                inst.addEventListener?.("loadError", onLoadError);
              } catch {
                /* older runtimes */
              }
            }}
          />
        ) : (
          <div className="wlth-animated-loader__fallback" aria-hidden="true">
            <span className="wlth-animated-loader__pulse" />
          </div>
        )}
      </div>
      <p className="wlth-animated-loader__title">{title}</p>
      {description ? (
        <p className="wlth-animated-loader__description">{description}</p>
      ) : null}
    </div>
  );
}

export const AnimatedLoader = memo(AnimatedLoaderImpl);

/** @deprecated Use AnimatedLoader — kept as alias for gradual migration */
export function WalkingLoader(props: {
  message?: string;
  compact?: boolean;
}) {
  return (
    <AnimatedLoader
      variant="walking"
      title={props.message || "Saving your progress…"}
      size={props.compact ? "small" : "medium"}
      fullScreen
    />
  );
}

export type { AnimationVariant };
