import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatedLoader, type AnimationVariant } from "./AnimatedLoader";

type Props = {
  open: boolean;
  variant: AnimationVariant;
  title: string;
  description?: string;
  label?: string;
};

/**
 * Full-viewport blocking loader portalled to document.body.
 * Survives Webflow transform/overflow stacking contexts.
 * Restores body overflow on unmount / close.
 */
export function PageBlockingLoader({
  open,
  variant,
  title,
  description,
  label,
}: Props) {
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="wlth-page-loader"
      role="alertdialog"
      aria-modal="true"
      aria-busy="true"
      aria-label={label || title}
    >
      <div className="wlth-page-loader__panel">
        <AnimatedLoader
          variant={variant}
          title={title}
          description={description}
          size="large"
          fullScreen
        />
      </div>
    </div>,
    document.body
  );
}
