/**
 * SweatPals membership widget host helpers.
 *
 * SweatPals' embed script mounts a tier-list iframe after its own <script>
 * tag and opens a checkout dialog. Their checkout iframe posts analytics
 * events to the parent page as:
 *   { action: "WIDGET_GTAG_EVENT", eventName, eventParams }
 *   { action: "WIDGET_META_EVENT", eventName, eventParams }
 * Their embed script forwards those to window.gtag / window.fbq when those
 * are defined — so defining stubs lets us capture every tracked event,
 * including registration_field_filled (the exact email typed in checkout)
 * and the purchase event.
 */

export type SweatpalsWidgetEvent =
  | {
      action: "WIDGET_GTAG_EVENT";
      eventName: string;
      eventParams: Record<string, unknown>;
    }
  | {
      action: "WIDGET_META_EVENT";
      eventName: string;
      eventParams: Record<string, unknown>;
    };

export type SweatpalsMembershipWidgetOptions = {
  /** Full URL of SweatPals' list-v2 embed script (env-dependent origin). */
  scriptUrl: string;
  /** SweatPals community username (communityUsername query param). */
  communityUsername: string;
  /** JSON array string of membership tier UUIDs to show (membershipTiersJson). */
  membershipTiersJson: string;
  /** Extra list-iframe query params (colors, font, title…) appended as-is. */
  styles?: Record<string, string>;
  /** Called for every analytics event forwarded by the widget iframes. */
  onEvent?: (event: SweatpalsWidgetEvent) => void;
};

type GtagLike = (...args: unknown[]) => void;

const MARKER_SCRIPT_ID = "wlth-sweatpals-membership-script";

function currentGtag(): GtagLike | undefined {
  const w = window as unknown as { gtag?: unknown };
  return typeof w.gtag === "function" ? (w.gtag as GtagLike) : undefined;
}

function currentFbq(): GtagLike | undefined {
  const w = window as unknown as { fbq?: unknown };
  return typeof w.fbq === "function" ? (w.fbq as GtagLike) : undefined;
}

/**
 * Mount the SweatPals membership list widget inside `container`.
 *
 * Returns a cleanup function that removes the script, iframe(s) and message
 * listener, and restores any pre-existing window.gtag / window.fbq.
 */
export function mountSweatpalsMembershipWidget(
  container: HTMLElement,
  opts: SweatpalsMembershipWidgetOptions
): () => void {
  if (!opts.scriptUrl || !opts.communityUsername) {
    throw new Error("SweatPals widget requires scriptUrl and communityUsername");
  }

  const previousGtag = currentGtag();
  const previousFbq = currentFbq();
  const capturedGtagCalls: unknown[][] = [];
  const capturedFbqCalls: unknown[][] = [];

  const w = window as unknown as {
    gtag?: GtagLike;
    fbq?: GtagLike;
  };
  w.gtag = function (...args: unknown[]) {
    capturedGtagCalls.push(args);
    console.debug("sweatpals gtag", args);
  };
  w.fbq = function (...args: unknown[]) {
    capturedFbqCalls.push(args);
    console.debug("sweatpals fbq", args);
  };

  const onMessage = (event: MessageEvent) => {
    const data = event.data as { action?: unknown } | null;
    if (!data || typeof data !== "object" || typeof data.action !== "string") {
      return;
    }
    if (data.action === "WIDGET_GTAG_EVENT" || data.action === "WIDGET_META_EVENT") {
      const payload = data as unknown as {
        action: "WIDGET_GTAG_EVENT" | "WIDGET_META_EVENT";
        eventName?: unknown;
        eventParams?: unknown;
      };
      console.debug("sweatpals widget event", payload.action, payload.eventName, payload.eventParams);
      opts.onEvent?.({
        action: payload.action,
        eventName: typeof payload.eventName === "string" ? payload.eventName : "",
        eventParams:
          payload.eventParams && typeof payload.eventParams === "object"
            ? (payload.eventParams as Record<string, unknown>)
            : {},
      });
    }
  };
  window.addEventListener("message", onMessage);

  const script = document.createElement("script");
  script.id = MARKER_SCRIPT_ID;
  script.async = true;
  const url = new URL(opts.scriptUrl);
  url.searchParams.set("communityUsername", opts.communityUsername);
  url.searchParams.set("membershipTiersJson", opts.membershipTiersJson);
  url.searchParams.set("enableAutoEmbed", "true");
  for (const [key, value] of Object.entries(opts.styles ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  script.src = url.toString();
  container.appendChild(script);

  return () => {
    script.remove();
    // Remove any iframe the embed script inserted inside the container.
    container
      .querySelectorAll('iframe[id^="sweatpals_"], dialog[id^="sweatpals_"]')
      .forEach((el) => el.remove());
    document
      .querySelectorAll('dialog[id^="sweatpals_checkout_dialog_"]')
      .forEach((el) => el.remove());
    window.removeEventListener("message", onMessage);
    if (previousGtag) {
      w.gtag = previousGtag;
    } else {
      delete w.gtag;
    }
    if (previousFbq) {
      w.fbq = previousFbq;
    } else {
      delete w.fbq;
    }
    void capturedGtagCalls;
    void capturedFbqCalls;
  };
}
