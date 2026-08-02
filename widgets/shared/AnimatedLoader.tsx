import { memo, useEffect, useState } from "react";
import { DotLottieReact } from "@lottiefiles/dotlottie-react";
import {
  type AnimationVariant,
  getAnimationData,
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
 * Shared animated loader. Animation bytes are inlined in the widget bundle.
 * A CSS ring is always visible until DotLottie reports load (or fails).
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
  const px = SIZE_PX[size];

  // Synchronous — data is bundled, no fetch race
  const [payload, setPayload] = useState<ArrayBuffer | null>(() =>
    getAnimationData(variant)
  );
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    payload ? "loading" : "error"
  );

  useEffect(() => {
    const next = getAnimationData(variant);
    setPayload(next);
    setStatus(next ? "loading" : "error");
  }, [variant]);

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
        style={{ width: px, height: px, minWidth: px, minHeight: px }}
      >
        {payload && status !== "error" ? (
          <div
            className="wlth-animated-loader__player"
            style={{
              width: px,
              height: px,
              opacity: status === "ready" ? 1 : 0,
              transition: "opacity 0.2s ease",
            }}
          >
            <DotLottieReact
              key={variant}
              data={payload}
              loop={!reducedMotion}
              autoplay={!reducedMotion}
              segment={reducedMotion ? [0, 1] : undefined}
              layout={{ fit: "contain", align: [0.5, 0.5] }}
              renderConfig={{ autoResize: true, devicePixelRatio: 2 }}
              style={{ width: px, height: px, display: "block" }}
              dotLottieRefCallback={(inst) => {
                if (!inst) return;
                const onLoad = () => setStatus("ready");
                const onErr = () => {
                  setStatus("error");
                  try {
                    console.warn(
                      `[wlth] Lottie runtime failed variant="${variant}"`
                    );
                  } catch {
                    /* ignore */
                  }
                };
                try {
                  inst.addEventListener("load", onLoad);
                  inst.addEventListener("loadError", onErr);
                  if (inst.isLoaded) onLoad();
                } catch {
                  // If events unavailable, reveal after a short beat
                  window.setTimeout(() => setStatus("ready"), 400);
                }
              }}
            />
          </div>
        ) : null}

        {/* Always-on visible ring until Lottie is ready (or if it failed) */}
        {status !== "ready" ? (
          <div className="wlth-animated-loader__spinner" aria-hidden="true">
            <span className="wlth-animated-loader__spinner-ring" />
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
