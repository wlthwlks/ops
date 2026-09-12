import { useEffect, useRef } from "react";
import {
  mountSweatpalsMembershipWidget,
  type SweatpalsWidgetEvent,
} from "../../shared/sweatpals-membership";

type SweatpalsPaymentPreviewProps = {
  scriptUrl: string;
  communityUsername: string;
  membershipTiersJson: string;
  onEvent?: (event: SweatpalsWidgetEvent) => void;
};

/**
 * Shadow-mode host for the SweatPals membership widget inside the signup
 * payment step. Mounts the embed script while the payment step is visible and
 * removes it (script, iframes, checkout dialog, listeners) on unmount.
 */
export function SweatpalsPaymentPreview(props: SweatpalsPaymentPreviewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const onEventRef = useRef(props.onEvent);

  useEffect(() => {
    onEventRef.current = props.onEvent;
  }, [props.onEvent]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const cleanup = mountSweatpalsMembershipWidget(container, {
      scriptUrl: props.scriptUrl,
      communityUsername: props.communityUsername,
      membershipTiersJson: props.membershipTiersJson,
      onEvent: (event) => onEventRef.current?.(event),
    });
    return cleanup;
  }, [props.scriptUrl, props.communityUsername, props.membershipTiersJson]);

  return (
    <section className="wlth-sweatpals-preview">
      <h2>Membership</h2>
      <p className="wlth-sweatpals-note">
        Choose your membership below — payment is handled securely by SweatPals.
      </p>
      <div className="wlth-sweatpals-container" ref={containerRef} />
    </section>
  );
}
