type WalkingLoaderProps = {
  message?: string;
  compact?: boolean;
};

/**
 * Lightweight walking / footstep loader for signup & update-details transitions.
 * Inline SVG + CSS only. Honours prefers-reduced-motion.
 */
export function WalkingLoader(props: WalkingLoaderProps) {
  const message = props.message || "Saving your progress…";
  return (
    <div
      className={`wlth-walk-loader${props.compact ? " is-compact" : ""}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="wlth-walk-visual" aria-hidden="true">
        <svg className="wlth-walk-svg" viewBox="0 0 80 40" width="80" height="40">
          <g className="wlth-walk-figure">
            <circle cx="28" cy="8" r="4" fill="currentColor" />
            <path
              d="M28 12 L28 24 M28 16 L20 20 M28 16 L36 14 M28 24 L22 34 M28 24 L34 34"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
          <ellipse className="wlth-foot wlth-foot-a" cx="22" cy="36" rx="5" ry="2.2" />
          <ellipse className="wlth-foot wlth-foot-b" cx="34" cy="36" rx="5" ry="2.2" />
          <path
            className="wlth-walk-path"
            d="M8 36 H72"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="3 4"
            opacity="0.25"
          />
        </svg>
      </div>
      <p className="wlth-walk-msg">{message}</p>
    </div>
  );
}
