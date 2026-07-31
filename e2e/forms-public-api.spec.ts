import { test, expect } from "@playwright/test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

test.describe("forms public API smoke", () => {
  test("reference-data onboarding is public and structured", async ({ request }) => {
    const res = await request.get("/api/reference-data/onboarding");
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(Array.isArray(json.countries)).toBe(true);
    expect(Array.isArray(json.cities)).toBe(true);
    expect(Array.isArray(json.availabilityOptions)).toBe(true);
    expect(json.availabilityOptions.length).toBe(21);
  });

  test("forms config exposes flags without secrets", async ({ request }) => {
    const res = await request.get("/api/forms/config");
    expect(res.ok()).toBeTruthy();
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.flags).toBeTruthy();
    const body = JSON.stringify(json);
    expect(body).not.toMatch(/sk_live_|sk_test_|whsec_|MEMBERSTACK_SECRET/);
  });

  test("onboarding bootstrap rate-limits or rejects unauthenticated", async ({
    request,
  }) => {
    const res = await request.post("/api/onboarding/bootstrap", {
      data: { firstName: "A", lastName: "B", email: "a@b.com" },
    });
    // Without Memberstack token: 401/500 config, not 200 success write
    expect(res.status()).not.toBe(200);
  });
});

test.describe("widget build artifacts", () => {
  test("signup and update-details bundles exist", () => {
    const root = process.cwd();
    expect(existsSync(join(root, "public/widgets/signup/v1/signup.js"))).toBe(true);
    expect(existsSync(join(root, "public/widgets/signup/v1/signup.css"))).toBe(true);
    expect(
      existsSync(join(root, "public/widgets/update-details/v1/update-details.js"))
    ).toBe(true);
    const js = readFileSync(join(root, "public/widgets/signup/v1/signup.js"), "utf8");
    expect(js.length).toBeGreaterThan(1000);
    expect(js).not.toMatch(/MEMBERSTACK_SECRET|AIRTABLE_GET_DATA_TOKEN|sk_live_/);
  });

  test("signup bundle includes stepper and form validation markers", () => {
    const js = readFileSync(
      join(process.cwd(), "public/widgets/signup/v1/signup.js"),
      "utf8"
    );
    // Bundled strings from Stepperize / RHF integration
    expect(js).toMatch(/Join WLTH WLKS|wlth-signup|firstName|Continue/);
    expect(js.length).toBeGreaterThan(50_000);
  });
});

test.describe("CORS preflight", () => {
  test("reference-data answers OPTIONS", async ({ request }) => {
    const res = await request.fetch("/api/reference-data/onboarding", {
      method: "OPTIONS",
      headers: { Origin: "https://wlthwlks.com" },
    });
    expect([200, 204]).toContain(res.status());
  });
});

