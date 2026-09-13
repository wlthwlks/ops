import { defineConfig } from "@playwright/test";

/**
 * SweatPals E2E suite (e2e/sweatpals).
 *
 * Runs against `next dev` on :3000 with .env.local — ALLOW_MEMBERSTACK_TEST_AUTH
 * and the Stripe/SweatPals staging credentials only work outside production.
 *
 *   npm run test:e2e:sweatpals                        (headless: tests B + C)
 *   SWEATPALS_E2E_HEADED=1 npm run test:e2e:sweatpals  (headed: adds test A — real Stripe payment)
 */
export default defineConfig({
  testDir: "e2e/sweatpals",
  timeout: 300_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3000",
    trace: "retain-on-failure",
    headless: process.env.SWEATPALS_E2E_HEADED !== "1",
    viewport: { width: 1280, height: 900 },
    launchOptions: {
      // Reduce automation fingerprints — Stripe's fraud checks look for these.
      args: ["--disable-blink-features=AutomationControlled"],
    },
  },
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
    ? undefined
    : {
        command: "npx next dev -p 3000",
        url: "http://127.0.0.1:3000/api/health",
        reuseExistingServer: !process.env.CI,
        timeout: 240_000,
      },
});
