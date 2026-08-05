import { describe, it, expect, vi } from "vitest";
import { runOutboundCheckout } from "../../../widgets/shared/checkout-outbound";

describe("outbound checkout loader safety", () => {
  it("does not call confirmPaymentFromServer after purchase resolves", async () => {
    const confirm = vi.fn(async () => undefined);
    const purchase = vi.fn(async () => ({ ok: true }));

    const outcome = await runOutboundCheckout({
      purchase,
      confirmPaymentFromServer: confirm,
    });

    expect(outcome).toBe("navigating_or_closed");
    expect(purchase).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("returns error when purchase throws without confirming payment", async () => {
    const confirm = vi.fn(async () => undefined);
    const purchase = vi.fn(async () => {
      throw new Error("closed");
    });

    const outcome = await runOutboundCheckout({
      purchase,
      confirmPaymentFromServer: confirm,
    });

    expect(outcome).toBe("error");
    expect(confirm).not.toHaveBeenCalled();
  });
});
