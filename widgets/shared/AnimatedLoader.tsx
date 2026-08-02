import { memo, useEffect, useMemo, useState } from "react";
import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import {
  type AnimationVariant,
  loadAnimationData,
  prefetchAnimations,
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

const SIZE_PX: Record<AnimatedLoaderSize, number> = {
  small: 140,
  medium: 210,
  large: 280,
};

// Kick off fetches as soon as the widget bundle evaluates
if (typeof window !== "undefined") {
  try {
    prefetchAnimations();
  } catch {
    /* ignore */
  }
}

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

/**
 * Shared animated loader for Signup + Update Details.
 * Loads local .lottie bytes (cached) and feeds DotLottie via `data`
 * so playback does not depend on a fragile relative src mid-transition.
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
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  const px = SIZE_PX[size];

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    setReady(false);
    setData(null);

    void loadAnimationData(variant).then((buf) => {
      if (cancelled) return;
      if (!buf) {
        setFailed(true);
        return;
      }
      // Clone so DotLottie can take ownership without detaching our cache
      setData(buf.slice(0));
    });

    return () => {
      cancelled = true;
    };
  }, [variant]);

  const showPlayer = Boolean(data) && !failed;

  const playerStyle = useMemo(
    () => ({
      width: px,
      height: px,
      maxWidth: "100%",
      maxHeight: "100%",
    }),
    [px]
  );

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
      <div
        className="wlth-animated-loader__animation"
        aria-hidden="true"
        style={{ width: px, height: px }}
      >
        {showPlayer ? (
          <DotLottieReact
            key={variant}
            data={data!}
            loop={!reducedMotion}
            autoplay={!reducedMotion}
            segment={reducedMotion ? [0, 1] : undefined}
            layout={{ fit: "contain", align: [0.5, 0.5] }}
            renderConfig={{ autoResize: true }}
            // Do NOT pass className — DotLottie skips 100% size styles when className is set
            style={playerStyle}
            dotLottieRefCallback={(inst) => {
              if (!inst) return;
              const markReady = () => setReady(true);
              const markFail = () => {
                setFailed(true);
                try {
                  console.warn(
                    `[wlth] Lottie runtime failed variant="${variant}"`
                  );
                } catch {
                  /* ignore */
                }
              };
              try {
                inst.addEventListener?.("load", markReady);
                inst.addEventListener?.("loadError", markFail);
                // Already loaded by the time callback runs
                if ((inst as { isLoaded?: boolean }).isLoaded) markReady();
              } catch {
                markReady();
              }
            }}
          />
        ) : null}

        {/* Soft placeholder until first frame (not a black “failed” pulse) */}
        {!ready && !failed ? (
          <div className="wlth-animated-loader__placeholder" aria-hidden="true" />
        ) : null}

        {failed ? (
          <div className="wlth-animated-loader__fallback" aria-hidden="true">
            <span className="wlth-animated-loader__pulse" />
          </div>
        ) : null}
      </div>
      <p className="wlth-animated-loader__title">{title}</p>
      {description ? (
        <p className="wlth-animated-loader__description">{description}</p>
      ) : null}
    </div>
  );
}

export const AnimatedLoader = memo(AnimatedLoaderImpl);

/** @deprecated Use AnimatedLoader */
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
