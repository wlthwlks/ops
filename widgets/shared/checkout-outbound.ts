/**
 * Outbound checkout must never call payment-return confirmation.
 * Kept free of React/Lottie imports so unit tests can import it in Node.
 */
export async function runOutboundCheckout(opts: {
  purchase: () => Promise<unknown>;
  confirmPaymentFromServer: (token: string | null) => Promise<void>;
}): Promise<"navigating_or_closed" | "error"> {
  try {
    await opts.purchase();
    // Do NOT call confirmPaymentFromServer here — only Stripe-return mount path may.
    void opts.confirmPaymentFromServer;
    return "navigating_or_closed";
  } catch {
    return "error";
  }
}
