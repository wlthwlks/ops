import { test, expect, type Page } from "@playwright/test";
import { createHash } from "crypto";
import {
  airtableFindMember,
  cleanupAllTestData,
  e2eEmail,
  e2ePhoneLocal,
  getSweatpalsRowsForMember,
  installWidgetHarness,
  pickSeededActiveMember,
  registerTestIdentity,
  signupCreationExists,
  testAuthHeaders,
  testMemberId,
} from "./helpers";

const CHECKOUT_DIALOG = "#sweatpals_checkout_dialog_wlth_wlks_demo_925264";
const GOAL_STEP_TEXT = /most important goal for the next 90 days/i;

test.afterEach(async () => {
  const cleaned = await cleanupAllTestData();
  if (cleaned.length > 0) console.log("cleaned test data:", cleaned.join(", "));
});

async function waitForWidget(page: Page) {
  await page.waitForSelector("#wlth-signup-root #fn", { timeout: 60_000 });
}

async function completeSignupStepsToPayment(page: Page, email: string) {
  await waitForWidget(page);

  // —— account ——
  await page.fill("#fn", "E2E");
  await page.fill("#ln", "Walker");
  await page.selectOption("#age", { index: 1 });
  await page.fill("#em", email);
  await page.fill("#pw", "E2ePassw0rd!");
  await page.getByRole("button", { name: "Continue" }).first().click();

  // —— location ——
  await page.waitForSelector("#wlth-country", { timeout: 60_000 });
  await page.selectOption("#wlth-country", { label: "United States" });
  // City options load async after country selection; the styled select keeps
  // native <option>s hidden, so poll the option list instead of visibility.
  await page.waitForFunction(
    () => {
      const sel = document.getElementById("wlth-city") as HTMLSelectElement | null;
      return Boolean(sel && sel.options.length > 1);
    },
    undefined,
    { timeout: 30_000 }
  );
  await page.selectOption("#wlth-city", { index: 1 });
  await page.fill("#signup-ph-number", "4155550100");
  await page.getByRole("button", { name: "Continue" }).first().click();

  // —— business ——
  await page.waitForSelector("#wlth-ind", { timeout: 60_000 });
  await page.selectOption("#wlth-ind", { index: 1 });
  await page.selectOption("#wlth-stage", { index: 1 });
  await page.selectOption("#wlth-rev", { index: 1 });
  await page.fill(
    "#wlth-desc",
    "We connect founders through curated walks and honest conversations about building businesses."
  );
  await page.getByRole("button", { name: "+ Add social profile" }).click();
  await page.getByRole("button", { name: /LinkedIn|Instagram|Website/i }).first().click();
  await page.fill("input[id^='signup-social-']", "https://www.linkedin.com/in/e2etest");
  await page.getByRole("button", { name: "Continue to payment" }).click();
}

async function fillSweatpalsCheckout(page: Page, email: string) {
  const co = page.frameLocator(`${CHECKOUT_DIALOG} iframe`);

  // Identity
  await co.locator("input[name=fullName]").fill("E2E Walker", { timeout: 60_000 });
  await co.locator("input[name=email]").fill(email);
  // Phone: switch the dial code to New Zealand (+64), then type the local number.
  const dial = co
    .locator('[role="combobox"]')
    .filter({ hasText: /^\+\d{1,3}$/ })
    .first();
  if ((await dial.count()) > 0) {
    await dial.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(800);
    const nz = co.getByText(/New Zealand/i).first();
    if ((await nz.count()) > 0) {
      await nz.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(600);
    }
  }
  await co.locator("input[type=tel]").first().fill(e2ePhoneLocal());
  await co.getByRole("button", { name: /Next: Waiver/i }).click();

  // Waiver (SweatPals renders the modal twice in dev — target the first).
  const initials = co.locator("input[name=participantInitials]").first();
  for (let attempt = 0; attempt < 3; attempt++) {
    await co.locator("#waiver-agreement").scrollIntoViewIfNeeded().catch(() => undefined);
    await co.locator("#waiver-agreement").click({ force: true }).catch(() => undefined);
    try {
      await initials.waitFor({ state: "visible", timeout: 15_000 });
      break;
    } catch {
      // Modal did not open — retry the checkbox.
      const text = (await co.locator("body").innerText().catch(() => ""))
        .replace(/\s+/g, " ")
        .slice(0, 260);
      console.log(`[waiver retry ${attempt + 1}] checkout body: ${text}`);
      await page.waitForTimeout(1500);
    }
  }
  // Agree inside the VISIBLE modal that holds the initials input — SweatPals
  // renders the modal twice, and only the visible instance flips the checkbox.
  for (const modal of await co.locator("[role=dialog]").all()) {
    if (!(await modal.isVisible().catch(() => false))) continue;
    const modalInitials = modal.locator("input[name=participantInitials]");
    if ((await modalInitials.count()) === 0) continue;
    await modalInitials.fill("ET");
    const agree = modal.getByRole("button", { name: /Agree and sign/i });
    for (let attempt = 0; attempt < 3; attempt++) {
      await agree.click({ force: true }).catch(() => undefined);
      await page.waitForTimeout(1200);
      if ((await co.locator("#waiver-agreement").getAttribute("data-state")) === "checked") break;
    }
    break;
  }
  expect(await co.locator("#waiver-agreement").getAttribute("data-state")).toBe("checked");
  await co.getByRole("button", { name: /Next: Questions/i }).click();

  // Registration questions
  await page.waitForTimeout(2000);
  await co.getByRole("button", { name: /^Start$/i }).click();
  await page.waitForTimeout(2000);
  await co.locator("input[name=emergency-contact-name]").fill("Test Contact");
  // The emergency phone validates against the form's default country (+1) —
  // the NZ number only applies to the identity "Mobile" field above.
  await co.locator("input[type=tel]").first().fill("4155550001");
  const selects = co.locator("[role=combobox]");
  await selects.nth(0).click();
  await page.waitForTimeout(800);
  await co.getByRole("option", { name: "Beginner" }).first().click();
  await page.waitForTimeout(500);
  await co.getByText("M", { exact: true }).last().click();
  // DOB picker — retry until the trigger no longer shows "Select date".
  for (let attempt = 0; attempt < 3; attempt++) {
    const trigger = co.getByText("Select date", { exact: false }).first();
    if ((await trigger.count()) === 0) break;
    await trigger.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(1500);
    const cells = co.locator("[role=gridcell] button, button[role=gridcell]");
    if ((await cells.count()) > 0) {
      await cells.nth(5).click();
      await page.waitForTimeout(800);
      const okBtn = co
        .locator("[role=dialog]")
        .last()
        .getByRole("button", { name: /^OK$/i })
        .first();
      if (await okBtn.count()) await okBtn.click();
    }
    await page.waitForTimeout(1200);
  }
  await co.getByRole("button", { name: /^Done$/i }).click({ force: true, timeout: 10_000 });
  await page.waitForTimeout(1500);
  const next = co.getByRole("button", { name: /Next: Payment/i });
  if (await next.isDisabled().catch(() => true)) {
    // Last-resort: re-validate with US-format fallbacks and retry Done.
    const tel = co.locator("input[type=tel]").first();
    if ((await tel.count()) > 0) await tel.fill("4155550001");
    await page.waitForTimeout(800);
    await co.getByRole("button", { name: /^Done$/i }).click({ force: true, timeout: 10_000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  }
  await next.click();
}

async function typeStripeCard(page: Page): Promise<boolean> {
  // Wait for the Stripe payment-element frame (mounted async after the step loads).
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    for (const frame of page.frames()) {
      if (!frame.url().startsWith("https://js.stripe.com")) continue;
      if ((await frame.locator('input[name="number"]').count()) > 0) {
        found = true;
        break;
      }
    }
    if (!found) await page.waitForTimeout(1500);
  }
  if (!found) return false;

  for (const frame of page.frames()) {
    if (!frame.url().startsWith("https://js.stripe.com")) continue;
    const number = frame.locator('input[name="number"]').first();
    if ((await number.count()) === 0) continue;
    await number.click();
    await number.pressSequentially("4242424242424242", { delay: 80 });
    const expiry = frame.locator('input[name="expiry"]').first();
    if (await expiry.count()) {
      await expiry.click();
      await expiry.pressSequentially("1234", { delay: 80 });
    }
    const cvc = frame.locator('input[name="cvc"]').first();
    if (await cvc.count()) {
      await cvc.click();
      await cvc.pressSequentially("424", { delay: 80 });
    }
    const zip = frame.locator('input[name="postalCode"], input[name="postal"]').first();
    if (await zip.count()) {
      await zip.click();
      await zip.pressSequentially("10001", { delay: 80 });
    }
    const val = (await number.inputValue().catch(() => "")).replace(/\s/g, "");
    console.log("typed card number length:", val.length);
    return val.length >= 12;
  }
  return false;
}

test("C — signup host page renders and reaches the SweatPals payment step (headless)", async ({
  page,
}) => {
  const memberId = testMemberId("e2e-c");
  const email = e2eEmail(1);
  registerTestIdentity({ memberId, email });
  await installWidgetHarness(page, { memberId, email });
  await page.goto("/dev-signup-host.html");

  await completeSignupStepsToPayment(page, email);

  // SweatPals tier list iframe renders in our payment step
  const listFrame = page.frameLocator('iframe[id^="sweatpals_membership_list"]');
  await expect(listFrame.locator("body")).toContainText(/Memberships|Founder Walk/i, {
    timeout: 30_000,
  });

  // Buy Now opens the checkout dialog
  await listFrame.getByRole("button", { name: /Buy/i }).first().click();
  await expect(page.locator(CHECKOUT_DIALOG)).toBeVisible({ timeout: 15_000 });
  const co = page.frameLocator(`${CHECKOUT_DIALOG} iframe`);
  await expect(co.locator("input[name=fullName]")).toBeVisible({ timeout: 30_000 });
});

test("B — registration + seeded SweatPals membership → Postgres & Airtable linkage (headless)", async ({
  request,
}) => {
  const seeded = await pickSeededActiveMember();
  if (!seeded) {
    test.skip(true, "no active seeded SweatPals member — run feed sync first");
    return;
  }

  // Deterministic member id per seeded email: reruns reuse the same records (cleaned after each run).
  const hash = createHash("sha1").update(seeded.email).digest("hex").slice(0, 12);
  const memberId = `e2e-seeded-${hash}`;
  registerTestIdentity({ memberId, email: seeded.email });

  const boot = await request.post("/api/onboarding/bootstrap", {
    headers: testAuthHeaders(memberId, seeded.email),
    data: {
      firstName: "E2E",
      lastName: "Walker",
      age: "25-34",
      email: seeded.email,
    },
  });
  expect(boot.status()).toBeLessThan(500);

  const verify = await request.post("/api/onboarding/sweatpals-verify", {
    headers: testAuthHeaders(memberId, seeded.email),
    data: { email: seeded.email },
  });
  expect(verify.ok()).toBeTruthy();
  const body = await verify.json();
  expect(body.membershipConfirmed).toBe(true);
  expect(body.active).toBe(true);

  // Postgres: membership rows linked to the member id
  const rows = await getSweatpalsRowsForMember(memberId);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.some((r) => r.active)).toBe(true);

  // Postgres: signup lock row exists
  expect(await signupCreationExists(memberId)).toBe(true);

  // Airtable: member record + billing mirror
  const records = await airtableFindMember(memberId);
  expect(records.length).toBeGreaterThan(0);
  const fields = records[0].fields;
  expect(String(fields["Membership"] ?? "")).toBe("Active");
  expect(String(fields["Payment"] ?? "")).toBe("Paid");
  expect(String(fields["Service access until"] ?? "").length).toBeGreaterThan(0);
});

async function confirmStripePayment(
  page: Page,
  co: ReturnType<Page["frameLocator"]>,
  checkoutFrame?: import("@playwright/test").Frame | undefined
): Promise<boolean> {
  const submit = co.locator("#checkout-form-submit-button");
  for (let i = 0; i < 8; i++) {
    const txt = (await co.locator("body").innerText().catch(() => ""))
      .replace(/\s+/g, " ");
    if (/thank|success|confirmed|congrat/i.test(txt)) return true;

    // The AI-agent disclosure checkbox may re-appear — keep it checked.
    for (const f of page.frames()) {
      if (!f.url().startsWith("https://js.stripe.com")) continue;
      const ai = f.getByRole("checkbox", { name: /AI agent acting on behalf/i }).first();
      if ((await ai.count()) > 0) {
        await ai.check({ force: true }).catch(() => undefined);
      }
      for (const pattern of [/pay another way/i, /not now/i, /no thanks/i, /continue/i, /use card/i]) {
        const b = f.getByRole("button", { name: pattern }).first();
        if ((await b.count()) > 0 && (await b.isVisible().catch(() => false))) {
          await b.click({ force: true }).catch(() => undefined);
          console.log(`clicked stripe interstitial: ${pattern}`);
        }
      }
    }

    const pe = await checkoutFrame?.evaluate(() => {
      const w = window as unknown as { __pe?: unknown[] };
      return w.__pe;
    });
    if (i % 2 === 0 || i > 4) {
      console.log(
        `[confirm ${i}] pe=${JSON.stringify(pe)} body=${txt.replace(/\s+/g, " ").slice(0, 240)}`
      );
    }

    await submit.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(5000);
  }
  return false;
}

test("A — full browser signup + SweatPals checkout payment (4242) + DB linkage (headed)", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.SWEATPALS_E2E_HEADED !== "1",
    "requires a real browser for Stripe card entry (SWEATPALS_E2E_HEADED=1)"
  );

  const memberId = testMemberId("e2e-a");
  const email = e2eEmail(0);
  registerTestIdentity({ memberId, email });
  await installWidgetHarness(page, { memberId, email });
  await page.goto("/dev-signup-host.html");

  await completeSignupStepsToPayment(page, email);

  // Check intention + terms so the verify button is enabled
  const checks = page.locator(".wlth-intention__check input[type=checkbox]");
  await checks.nth(0).check();
  if ((await checks.count()) > 1) await checks.nth(1).check();

  const listFrame = page.frameLocator('iframe[id^="sweatpals_membership_list"]');
  await listFrame.getByRole("button", { name: /Buy/i }).first().click();
  await expect(page.locator(CHECKOUT_DIALOG)).toBeVisible({ timeout: 15_000 });

  await fillSweatpalsCheckout(page, email);

  // Stripe card — real keyboard events; Stripe automation detection may still block.
  const co = page.frameLocator(`${CHECKOUT_DIALOG} iframe`);
  const checkoutFrame = page
    .frames()
    .find((f) => f.url().includes("membership-checkout"));
  await checkoutFrame?.evaluate(() => {
    const w = window as unknown as { __pe?: unknown[] };
    w.__pe = [];
    window.addEventListener("message", (e) => {
      try {
        const d = e.data as { action?: string; payload?: { event?: string; data?: unknown } };
        if (d?.action === "stripe-frame-event" && d?.payload?.event === "pe-change") {
          const data = d.payload.data as { complete?: boolean; empty?: boolean };
          w.__pe?.push({ c: data.complete, e: data.empty });
        }
      } catch {
        /* ignore */
      }
    });
  });

  const humanAssisted = process.env.SWEATPALS_E2E_HUMAN_PAYMENT === "1";
  if (humanAssisted) {
    // Stripe's AI-agent rules prevent automated agents from completing the
    // payment by design — a human completes just the card entry by hand in
    // the headed browser window; automation resumes for verification + DB
    // linkage checks.
    console.log(
      "=== HUMAN ACTION REQUIRED: in the open browser window, type the test card " +
        "(4242 4242 4242 4242, 12/34, CVC 424, any zip) and click Confirm & Pay. " +
        "Waiting up to 10 minutes…"
    );
    try {
      await expect(co.locator("body")).toContainText(/thank|success|confirmed|congrat/i, {
        timeout: 600_000,
      });
    } catch {
      throw new Error("Human-assisted payment was not completed within 10 minutes");
    }
  } else {
    const typed = await typeStripeCard(page);
    expect(typed, "Stripe payment frame not found").toBe(true);
    await page.waitForTimeout(4000);

    // Stripe's automation detection surfaces an AI-agent disclosure checkbox and
    // may open the Link sheet over the card form — handle both before confirming.
    for (const frame of page.frames()) {
      if (!frame.url().startsWith("https://js.stripe.com")) continue;
      const ai = frame.getByRole("checkbox", { name: /AI agent acting on behalf/i }).first();
      if (await ai.count()) {
        await ai.check({ force: true }).catch(() => undefined);
        console.log("Stripe AI-agent disclosure checked");
      }
      const linkClose = frame
        .getByRole("button", { name: /pay another way|close/i })
        .first();
      if ((await linkClose.count()) > 0 && (await linkClose.isVisible().catch(() => false))) {
        await linkClose.click({ force: true }).catch(() => undefined);
        console.log("Stripe Link sheet dismissed");
      }
    }
    await page.waitForTimeout(2000);

    const submit = co.locator("#checkout-form-submit-button");
    try {
      await expect(submit).toBeEnabled({ timeout: 120_000 });
    } catch {
      const framePe = await checkoutFrame?.evaluate(() => {
        const w = window as unknown as { __pe?: unknown[] };
        return w.__pe;
      });
      console.log("stripe pe-change (inside checkout frame):", JSON.stringify(framePe));
      throw new Error(
        "Stripe payment element never became complete — Stripe's AI-agent disclosure " +
          "blocks automated card entry by design. Re-run with SWEATPALS_E2E_HEADED=1 and " +
          "SWEATPALS_E2E_HUMAN_PAYMENT=1 to complete the card by hand."
      );
    }

    const paid = await confirmStripePayment(page, co, checkoutFrame);
    console.log("stripe confirm result:", paid);
    if (!paid) {
      throw new Error(
        "Stripe payment confirmation never completed — Stripe's AI-agent disclosure " +
          "blocks automated card entry by design. Re-run with SWEATPALS_E2E_HEADED=1 and " +
          "SWEATPALS_E2E_HUMAN_PAYMENT=1 to complete the card by hand."
      );
    }
  }

  // Close the SweatPals checkout dialog — it overlays our verify button.
  const closeBtn = page.locator(`${CHECKOUT_DIALOG} > button`).first();
  if ((await closeBtn.isVisible().catch(() => false))) {
    await closeBtn.click({ force: true }).catch(() => undefined);
  }
  if ((await page.locator(CHECKOUT_DIALOG).count()) > 0) {
    await page
      .locator(CHECKOUT_DIALOG)
      .evaluate((el) => (el as HTMLDialogElement).close())
      .catch(() => undefined);
  }
  await page.waitForTimeout(1500);
  const dialogText = (await co.locator("body").innerText().catch(() => ""))
    .replace(/\s+/g, " ")
    .slice(0, 300);
  console.log("checkout dialog text after payment:", dialogText);

  // Verify from our widget (purchase event auto-verify or the manual button).
  try {
    await expect(page.locator("body")).toContainText(GOAL_STEP_TEXT, { timeout: 60_000 });
  } catch {
    const verifyBtn = page.getByRole("button", { name: /verify my membership/i });
    if (await verifyBtn.isEnabled().catch(() => false)) {
      await verifyBtn.click({ timeout: 20_000 });
    }
  }
  await expect(page.locator("body")).toContainText(GOAL_STEP_TEXT, { timeout: 90_000 });

  // DB connection checks
  const rows = await getSweatpalsRowsForMember(memberId);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.some((r) => r.active)).toBe(true);
  expect(await signupCreationExists(memberId)).toBe(true);

  const records = await airtableFindMember(memberId);
  expect(records.length).toBeGreaterThan(0);
  const fields = records[0].fields;
  expect(String(fields["Membership"] ?? "")).toBe("Active");
  expect(String(fields["Payment"] ?? "")).toBe("Paid");
  expect(String(fields["Service access until"] ?? "").length).toBeGreaterThan(0);

  testInfo.attach("note", {
    body: `Created member ${memberId} (${email}) — cleaned up after this test.`,
  });
});
