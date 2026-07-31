import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { defineStepper } from "@stepperize/react";
import {
  accountFormSchema,
  businessFormSchema,
  connectionFormSchema,
  expertiseFormSchema,
  goalFormSchema,
  helpFormSchema,
  locationFormSchema,
  type AccountForm,
  type BusinessForm,
  type LocationForm,
} from "../../shared/widget-schemas";
import { widgetApi } from "../../shared/api";
import {
  authenticateEmailPassword,
  logMemberstackDiagnostics,
  tryResolveSessionAccessToken,
} from "../../shared/memberstack-auth";

const { useStepper } = defineStepper([
  { id: "account" },
  { id: "location" },
  { id: "business" },
  { id: "payment" },
  { id: "success" },
  { id: "goal" },
  { id: "help" },
  { id: "expertise" },
  { id: "connection" },
  { id: "done" },
] as const);

const STEP_LABELS: Record<string, string> = {
  account: "Account",
  location: "Location",
  business: "Business",
  payment: "Payment",
  success: "You’re in",
  goal: "Matching",
  help: "Help wanted",
  expertise: "Expertise",
  connection: "Connection",
  done: "Done",
};

/** Map Airtable / status resume stages → widget step ids */
function resumeStageToStep(resumeStage: string, paymentConfirmed?: boolean): string | null {
  const map: Record<string, string> = {
    LOCATION: "location",
    BUSINESS: "business",
    PAYMENT_PENDING: paymentConfirmed ? "goal" : "payment",
    PAYMENT_CONFIRMED: "goal",
    GOAL: "goal",
    HELP_WANTED: "help",
    EXPERTISE: "expertise",
    CONNECTION: "connection",
    COMPLETE: "done",
  };
  return map[resumeStage] || null;
}

function markPreGoalComplete(stepper: { setComplete: (id: never) => void }) {
  for (const id of ["account", "location", "business", "payment", "success"] as const) {
    stepper.setComplete(id as never);
  }
}

function clearPaymentQueryParam() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("payment")) return;
    url.searchParams.delete("payment");
    const qs = url.searchParams.toString();
    window.history.replaceState({}, "", url.pathname + (qs ? `?${qs}` : "") + url.hash);
  } catch {
    /* ignore */
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const FLOW_DOTS = ["account", "location", "business", "payment", "goal"] as const;

type RefData = {
  countries: Array<{ code: string; label: string }>;
  cities: Array<{ code: string; label: string; countryCode: string }>;
  industries: Array<{ code: string; label: string }>;
  businessStages: Array<{ code: string; label: string }>;
  revenueBrackets: Array<{ code: string; label: string }>;
  availabilityOptions: Array<{ code: string; label: string }>;
  helpWantedOptions: Array<{ code: string; label: string }>;
  expertiseOptions: Array<{ code: string; label: string }>;
  connectionTypes: Array<{ code: string; label: string }>;
};

function captureAttribution() {
  const p = new URLSearchParams(window.location.search);
  const keys = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "gclid",
    "fbclid",
  ] as const;
  const stored = sessionStorage.getItem("wlth_attribution");
  if (stored) {
    try {
      return JSON.parse(stored) as Record<string, string>;
    } catch {
      /* fall through */
    }
  }
  const attr: Record<string, string> = {
    initialLandingPage: window.location.href,
    initialReferrer: document.referrer || "",
    firstAttributionAt: new Date().toISOString(),
  };
  for (const k of keys) {
    const v = p.get(k);
    if (v) attr[k] = v;
  }
  sessionStorage.setItem("wlth_attribution", JSON.stringify(attr));
  return attr;
}

async function api(
  base: string,
  path: string,
  opts: RequestInit & { token?: string } = {}
) {
  return widgetApi(base, path, opts) as Promise<Record<string, unknown>>;
}

function FieldError({ message }: { message?: string }) {
  return <div className="wlth-error">{message || "\u00a0"}</div>;
}

export function SignupApp(props: { apiBase: string }) {
  // linear:false — resume / Stripe return must jump to goal (linear only allows +1 step)
  const stepper = useStepper({ linear: false, defaultStep: "account" });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refData, setRefData] = useState<RefData | null>(null);
  const [config, setConfig] = useState<{
    membershipPriceId: string;
    homeUrl: string;
  } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const attribution = useMemo(() => captureAttribution(), []);

  const resolveStripeCustomerIdFromMemberstack = async (): Promise<string | undefined> => {
    try {
      const dom = (
        window as unknown as {
          $memberstackDom?: {
            getCurrentMember?: () => Promise<unknown>;
          };
        }
      ).$memberstackDom;
      if (!dom?.getCurrentMember) return undefined;
      const raw = await dom.getCurrentMember();
      const root =
        raw && typeof raw === "object" && raw !== null && "data" in raw
          ? (raw as { data: unknown }).data
          : raw;
      const member =
        root && typeof root === "object" && root !== null && "member" in root
          ? (root as { member: unknown }).member
          : root;
      if (!member || typeof member !== "object") return undefined;
      const m = member as Record<string, unknown>;
      const candidates = [
        m.stripeCustomerId,
        m.stripe_customer_id,
        m.stripeId,
        isRecord(m.billing) ? (m.billing as Record<string, unknown>).stripeCustomerId : null,
        isRecord(m.auth) ? (m.auth as Record<string, unknown>).stripeCustomerId : null,
      ];
      for (const c of candidates) {
        if (typeof c === "string" && c.trim().startsWith("cus_")) return c.trim();
      }
    } catch {
      /* optional */
    }
    return undefined;
  };

  const advanceAfterPayment = async (accessToken: string | null) => {
    markPreGoalComplete(stepper);
    if (accessToken) {
      const stripeCustomerId = await resolveStripeCustomerIdFromMemberstack();
      try {
        await api(props.apiBase, "/api/onboarding/step", {
          method: "PATCH",
          token: accessToken,
          body: JSON.stringify({
            stage: "PAYMENT_CONFIRMED",
            data: stripeCustomerId ? { stripeCustomerId } : {},
          }),
        });
      } catch {
        // Retry once — Payment=Paid must land
        try {
          await api(props.apiBase, "/api/onboarding/step", {
            method: "PATCH",
            token: accessToken,
            body: JSON.stringify({
              stage: "PAYMENT_CONFIRMED",
              data: stripeCustomerId ? { stripeCustomerId } : {},
            }),
          });
        } catch {
          /* webhooks may still confirm */
        }
      }
      void api(props.apiBase, "/api/onboarding/analytics", {
        method: "POST",
        token: accessToken,
        body: JSON.stringify({ eventType: "PAYMENT_RETURNED" }),
      }).catch(() => undefined);
    }
    try {
      sessionStorage.setItem("wlth_payment_ok", "1");
      sessionStorage.removeItem("wlth_checkout_pending");
    } catch {
      /* ignore */
    }
    await stepper.goTo("goal");
    clearPaymentQueryParam();
  };

  const accountForm = useForm<AccountForm>({
    resolver: zodResolver(accountFormSchema),
    defaultValues: { firstName: "", lastName: "", email: "", password: "" },
    mode: "onBlur",
  });
  const locationForm = useForm<LocationForm>({
    resolver: zodResolver(locationFormSchema),
    defaultValues: { countryCode: "", cityCode: "", availability: [] },
    mode: "onBlur",
  });
  const businessForm = useForm<BusinessForm>({
    resolver: zodResolver(businessFormSchema),
    defaultValues: {
      primaryIndustry: "",
      businessStage: "",
      annualRevenue: "",
      businessDescription: "",
    },
    mode: "onBlur",
  });
  const goalForm = useForm({
    resolver: zodResolver(goalFormSchema),
    defaultValues: { ninetyDayGoal: "" },
  });
  const helpForm = useForm({
    resolver: zodResolver(helpFormSchema),
    defaultValues: { helpWanted: [] as string[], helpWantedContext: "" },
  });
  const expertiseForm = useForm({
    resolver: zodResolver(expertiseFormSchema),
    defaultValues: { expertiseOffered: [] as string[], expertiseContext: "" },
  });
  const connectionForm = useForm({
    resolver: zodResolver(connectionFormSchema),
    defaultValues: { connectionType: "" },
  });

  const countryCode = locationForm.watch("countryCode");
  const cities = useMemo(
    () => (refData?.cities || []).filter((c) => c.countryCode === countryCode),
    [refData, countryCode]
  );

  useEffect(() => {
    void (async () => {
      try {
        logMemberstackDiagnostics("widget_mount");
        const [cfg, ref] = await Promise.all([
          api(props.apiBase, "/api/forms/config"),
          api(props.apiBase, "/api/reference-data/onboarding"),
        ]);
        setConfig(cfg as { membershipPriceId: string; homeUrl: string });
        const rd = ref as unknown as RefData;
        setRefData(rd);
        if (!locationForm.getValues("countryCode") && rd.countries?.[0]?.code) {
          locationForm.setValue("countryCode", rd.countries[0].code);
        }

        // Session resume only via documented cookie/session API when available
        const t = await tryResolveSessionAccessToken();
        logMemberstackDiagnostics("session_resume", {
          tokenFound: Boolean(t),
          tokenType: t ? typeof t : "none",
        });
        if (t) setToken(t);

        const params = new URLSearchParams(window.location.search);
        const hashParams = new URLSearchParams(
          window.location.hash.startsWith("#")
            ? window.location.hash.slice(1)
            : window.location.hash
        );
        const paymentReturn = (
          params.get("payment") ||
          params.get("checkout") ||
          hashParams.get("payment") ||
          ""
        ).toLowerCase();
        // Stripe Checkout often appends session_id on success redirect
        const stripeSessionOk = Boolean(params.get("session_id"));
        let checkoutPending = false;
        let paymentOkFlag = false;
        try {
          checkoutPending = sessionStorage.getItem("wlth_checkout_pending") === "1";
          paymentOkFlag = sessionStorage.getItem("wlth_payment_ok") === "1";
        } catch {
          /* ignore */
        }

        // Post-pay path MUST win (linear stepper + webhook lag previously left users on Payment)
        if (paymentReturn === "success" || stripeSessionOk || paymentOkFlag) {
          await advanceAfterPayment(t);
        } else if (paymentReturn === "cancel") {
          try {
            sessionStorage.removeItem("wlth_checkout_pending");
          } catch {
            /* ignore */
          }
          if (t) {
            try {
              const status = await api(props.apiBase, "/api/onboarding/status", { token: t });
              const resume = resumeStageToStep(
                String(status.resumeStage || ""),
                Boolean(status.paymentConfirmed)
              );
              if (resume && resume !== "account") await stepper.goTo(resume as never);
              else await stepper.goTo("payment");
            } catch {
              await stepper.goTo("payment");
            }
          } else {
            await stepper.goTo("payment");
          }
          clearPaymentQueryParam();
        } else if (t) {
          try {
            const status = await api(props.apiBase, "/api/onboarding/status", { token: t });
            // Left for checkout and came back without query params — if paid or still pending after checkout, advance
            if (
              checkoutPending &&
              (Boolean(status.paymentConfirmed) ||
                String(status.onboardingStatus || "") === "PAYMENT_PENDING" ||
                String(status.onboardingStatus || "") === "PAYMENT_CONFIRMED")
            ) {
              // Prefer goal when checkout was started; confirm paid if webhook already landed
              if (Boolean(status.paymentConfirmed)) {
                await advanceAfterPayment(t);
              } else {
                // Still pending server-side — still move UX forward after checkout attempt return
                await advanceAfterPayment(t);
              }
            } else {
              const resume = resumeStageToStep(
                String(status.resumeStage || ""),
                Boolean(status.paymentConfirmed)
              );
              if (resume) {
                if (
                  resume === "goal" ||
                  resume === "help" ||
                  resume === "expertise" ||
                  resume === "connection" ||
                  resume === "done"
                ) {
                  markPreGoalComplete(stepper);
                }
                await stepper.goTo(resume as never);
              }
            }
          } catch {
            // Session token present but status failed — stay on account
          }
        }

        void api(props.apiBase, "/api/onboarding/analytics", {
          method: "POST",
          body: JSON.stringify({
            eventType: "FORM_VIEWED",
            utm_source: attribution.utm_source,
            utm_medium: attribution.utm_medium,
            utm_campaign: attribution.utm_campaign,
          }),
        }).catch(() => undefined);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load form");
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once
  }, [props.apiBase]);

  const saveStep = async (stage: string, data: unknown) => {
    if (!token) return;
    await api(props.apiBase, "/api/onboarding/step", {
      method: "PATCH",
      token,
      body: JSON.stringify({ stage, data }),
    });
  };

  const onAccount = accountForm.handleSubmit(async (values) => {
    if (loading) return; // prevent double submit
    setError(null);
    setLoading(true);
    try {
      logMemberstackDiagnostics("account_submit_start");
      const auth = await authenticateEmailPassword({
        email: values.email,
        password: values.password,
        firstName: values.firstName,
        lastName: values.lastName,
      });
      logMemberstackDiagnostics("account_auth_ok", {
        source: auth.source,
        tokenFound: true,
        tokenType: typeof auth.accessToken,
        memberIdPresent: Boolean(auth.memberId),
      });

      setToken(auth.accessToken);

      await api(props.apiBase, "/api/onboarding/bootstrap", {
        method: "POST",
        token: auth.accessToken,
        body: JSON.stringify({
          firstName: values.firstName,
          lastName: values.lastName,
          email: values.email,
          attribution,
        }),
      });

      // Resume correct stage when existing member returns
      try {
        const status = await api(props.apiBase, "/api/onboarding/status", {
          token: auth.accessToken,
        });
        const resume = resumeStageToStep(
          String(status.resumeStage || ""),
          Boolean(status.paymentConfirmed)
        );
        stepper.setComplete("account");
        if (resume && resume !== "account") {
          if (
            resume === "goal" ||
            resume === "help" ||
            resume === "expertise" ||
            resume === "connection" ||
            resume === "done"
          ) {
            markPreGoalComplete(stepper);
          }
          await stepper.goTo(resume as never);
        } else {
          await stepper.next();
        }
      } catch {
        stepper.setComplete("account");
        await stepper.next();
      }
    } catch (e) {
      logMemberstackDiagnostics("account_submit_error", {
        errorName: e instanceof Error ? e.name : "unknown",
        // message only — no tokens/passwords
        hasMessage: e instanceof Error && Boolean(e.message),
      });
      setError(e instanceof Error ? e.message : "Account step failed");
    } finally {
      setLoading(false);
    }
  });

  const onLocation = locationForm.handleSubmit(async (values) => {
    setError(null);
    setLoading(true);
    try {
      await saveStep("LOCATION", values);
      stepper.setComplete("location");
      await stepper.next();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Location save failed");
    } finally {
      setLoading(false);
    }
  });

  const onBusiness = businessForm.handleSubmit(async (values) => {
    setError(null);
    setLoading(true);
    try {
      await saveStep("BUSINESS", values);
      await saveStep("PAYMENT_PENDING", {});
      stepper.setComplete("business");
      await stepper.next();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Business save failed");
    } finally {
      setLoading(false);
    }
  });

  const startCheckout = async () => {
    setError(null);
    setLoading(true);
    const w = window as unknown as {
      $memberstackDom?: {
        purchasePlansWithCheckout?: (p: {
          priceId: string;
          successUrl: string;
          cancelUrl: string;
        }) => Promise<unknown>;
      };
    };
    const priceId = config?.membershipPriceId;
    if (!priceId) {
      setError("Membership price is not configured (MEMBERSTACK_MEMBERSHIP_PRICE_ID).");
      setLoading(false);
      return;
    }
    if (!w.$memberstackDom?.purchasePlansWithCheckout) {
      setError("Memberstack checkout is unavailable on this page.");
      setLoading(false);
      return;
    }
    const base = window.location.origin + window.location.pathname;
    try {
      sessionStorage.setItem("wlth_checkout_pending", "1");
    } catch {
      /* ignore */
    }
    await api(props.apiBase, "/api/onboarding/analytics", {
      method: "POST",
      body: JSON.stringify({ eventType: "CHECKOUT_STARTED" }),
    }).catch(() => undefined);
    try {
      // If checkout is embedded/modal, this promise resolves on success without a full redirect.
      // If it full-page redirects to Stripe, mount handler + sessionStorage covers the return.
      await w.$memberstackDom.purchasePlansWithCheckout({
        priceId,
        successUrl: `${base}?payment=success`,
        cancelUrl: `${base}?payment=cancel`,
      });
      // Resolved without unload → payment finished in-place
      let t = token;
      if (!t) t = await tryResolveSessionAccessToken();
      if (t) setToken(t);
      await advanceAfterPayment(t);
    } catch (e) {
      try {
        sessionStorage.removeItem("wlth_checkout_pending");
      } catch {
        /* ignore */
      }
      // User closed checkout / cancel — stay on payment
      const msg = e instanceof Error ? e.message : "";
      if (msg && !/cancel|closed|abort/i.test(msg)) {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  const finish = async () => {
    setError(null);
    setLoading(true);
    try {
      if (token) {
        await api(props.apiBase, "/api/onboarding/complete", {
          method: "POST",
          token,
        });
      }
      window.location.href = config?.homeUrl || "https://wlthwlks.com";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete");
    } finally {
      setLoading(false);
    }
  };

  const toggleMulti = (
    list: string[],
    code: string,
    max: number,
    onChange: (next: string[]) => void
  ) => {
    if (list.includes(code)) onChange(list.filter((c) => c !== code));
    else if (list.length < max) onChange([...list, code]);
  };

  if (!refData) {
    return (
      <div className="wlth-widget">
        <div className="wlth-card">
          <p>Loading…</p>
          {error && <div className="wlth-banner-error">{error}</div>}
        </div>
      </div>
    );
  }

  const progressPct = Math.round((stepper.progress || 0) * 100);

  return (
    <div className="wlth-widget">
      <div className="wlth-card">
        <div className="wlth-progress" aria-hidden>
          <span style={{ width: `${progressPct}%` }} />
        </div>
        <div className="wlth-steps" aria-label="Progress">
          {FLOW_DOTS.map((id) => (
            <span
              key={id}
              className={`wlth-step-dot ${
                stepper.is(id) ? "is-active" : stepper.isComplete(id) ? "is-done" : ""
              }`}
            >
              {STEP_LABELS[id]}
            </span>
          ))}
        </div>

        {error && (
          <div className="wlth-banner-error" role="alert">
            {error}
          </div>
        )}

        {stepper.is("account") && (
          <form onSubmit={onAccount} noValidate>
            <h1>Join WLTH WLKS</h1>
            <p>Create your account to continue.</p>
            <div className="wlth-field">
              <label htmlFor="fn">First name</label>
              <input
                id="fn"
                autoComplete="given-name"
                aria-invalid={!!accountForm.formState.errors.firstName}
                {...accountForm.register("firstName")}
              />
              <FieldError message={accountForm.formState.errors.firstName?.message} />
            </div>
            <div className="wlth-field">
              <label htmlFor="ln">Last name</label>
              <input
                id="ln"
                autoComplete="family-name"
                aria-invalid={!!accountForm.formState.errors.lastName}
                {...accountForm.register("lastName")}
              />
              <FieldError message={accountForm.formState.errors.lastName?.message} />
            </div>
            <div className="wlth-field">
              <label htmlFor="em">Email</label>
              <input
                id="em"
                type="email"
                autoComplete="email"
                aria-invalid={!!accountForm.formState.errors.email}
                {...accountForm.register("email")}
              />
              <FieldError message={accountForm.formState.errors.email?.message} />
            </div>
            <div className="wlth-field">
              <label htmlFor="pw">Password</label>
              <input
                id="pw"
                type="password"
                autoComplete="new-password"
                aria-invalid={!!accountForm.formState.errors.password}
                {...accountForm.register("password")}
              />
              <FieldError message={accountForm.formState.errors.password?.message} />
            </div>
            <div className="wlth-actions">
              <button type="submit" className="wlth-btn-primary" disabled={loading}>
                Continue
              </button>
            </div>
          </form>
        )}

        {stepper.is("location") && (
          <form onSubmit={onLocation} noValidate>
            <h2>Where are you based?</h2>
            <div className="wlth-field">
              <label htmlFor="country">Country</label>
              <select
                id="country"
                aria-invalid={!!locationForm.formState.errors.countryCode}
                {...locationForm.register("countryCode", {
                  onChange: () => locationForm.setValue("cityCode", ""),
                })}
              >
                <option value="">Select country</option>
                {refData.countries.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
              <FieldError message={locationForm.formState.errors.countryCode?.message} />
            </div>
            <div className="wlth-field">
              <label htmlFor="city">City</label>
              <select
                id="city"
                aria-invalid={!!locationForm.formState.errors.cityCode}
                {...locationForm.register("cityCode")}
              >
                <option value="">Select city</option>
                {cities.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
              <FieldError message={locationForm.formState.errors.cityCode?.message} />
            </div>
            <p className="wlth-muted">General availability (select all that apply)</p>
            <div className="wlth-check-grid">
              {refData.availabilityOptions.map((o) => {
                const selected = locationForm.watch("availability") || [];
                return (
                  <label key={o.code} className="wlth-check">
                    <input
                      type="checkbox"
                      checked={selected.includes(o.code)}
                      onChange={() =>
                        toggleMulti(selected, o.code, 21, (next) =>
                          locationForm.setValue("availability", next, {
                            shouldValidate: true,
                          })
                        )
                      }
                    />
                    <span>{o.label}</span>
                  </label>
                );
              })}
            </div>
            <FieldError message={locationForm.formState.errors.availability?.message} />
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-secondary"
                onClick={() => void stepper.prev()}
              >
                Back
              </button>
              <button type="submit" className="wlth-btn-primary" disabled={loading}>
                Continue
              </button>
            </div>
          </form>
        )}

        {stepper.is("business") && (
          <form onSubmit={onBusiness} noValidate>
            <h2>About your business</h2>
            <div className="wlth-field">
              <label htmlFor="ind">Primary industry</label>
              <select id="ind" {...businessForm.register("primaryIndustry")}>
                <option value="">Select</option>
                {refData.industries.map((i) => (
                  <option key={i.code} value={i.code}>
                    {i.label}
                  </option>
                ))}
              </select>
              <FieldError message={businessForm.formState.errors.primaryIndustry?.message} />
            </div>
            <div className="wlth-field">
              <label htmlFor="bstage">Business stage</label>
              <select id="bstage" {...businessForm.register("businessStage")}>
                <option value="">Select</option>
                {refData.businessStages.map((i) => (
                  <option key={i.code} value={i.code}>
                    {i.label}
                  </option>
                ))}
              </select>
              <FieldError message={businessForm.formState.errors.businessStage?.message} />
            </div>
            <div className="wlth-field">
              <label htmlFor="rev">Approximate annual revenue</label>
              <select id="rev" {...businessForm.register("annualRevenue")}>
                <option value="">Select</option>
                {refData.revenueBrackets.map((i) => (
                  <option key={i.code} value={i.code}>
                    {i.label}
                  </option>
                ))}
              </select>
              <FieldError message={businessForm.formState.errors.annualRevenue?.message} />
            </div>
            <div className="wlth-field">
              <label htmlFor="desc">What does your business do, and who does it help?</label>
              <textarea id="desc" rows={4} {...businessForm.register("businessDescription")} />
              <FieldError
                message={businessForm.formState.errors.businessDescription?.message}
              />
            </div>
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-secondary"
                onClick={() => void stepper.prev()}
              >
                Back
              </button>
              <button type="submit" className="wlth-btn-primary" disabled={loading}>
                Continue to payment
              </button>
            </div>
          </form>
        )}

        {stepper.is("payment") && (
          <>
            <h2>Payment</h2>
            <p>Secure checkout is handled by Memberstack / Stripe.</p>
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                onClick={() => void startCheckout()}
              >
                Continue to checkout
              </button>
            </div>
          </>
        )}

        {stepper.is("success") && (
          <>
            <h1>You’re in!</h1>
            <p>Next: a few questions so we can improve your matching results.</p>
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                onClick={() => void stepper.goTo("goal")}
              >
                Improve your matching results
              </button>
              <button
                type="button"
                className="wlth-btn-secondary"
                onClick={() => void finish()}
              >
                Go to home
              </button>
            </div>
          </>
        )}

        {stepper.is("goal") && (
          <form
            onSubmit={goalForm.handleSubmit(async (v) => {
              setError(null);
              try {
                await saveStep("GOAL", v);
                await stepper.goTo("help");
              } catch (e) {
                setError(e instanceof Error ? e.message : "Save failed");
              }
            })}
            noValidate
          >
            <h2>Improve your matching results!</h2>
            <p className="wlth-muted">
              Tell us what you’re focused on so we can introduce you to the right people.
            </p>
            <div className="wlth-field">
              <label htmlFor="goal">
                What’s the most important thing you want help with right now?
              </label>
              <textarea id="goal" rows={4} {...goalForm.register("ninetyDayGoal")} />
              <FieldError message={goalForm.formState.errors.ninetyDayGoal?.message as string} />
            </div>
            <div className="wlth-actions">
              <button type="submit" className="wlth-btn-primary">
                Continue
              </button>
            </div>
          </form>
        )}

        {stepper.is("help") && (
          <form
            onSubmit={helpForm.handleSubmit(async (v) => {
              setError(null);
              try {
                await saveStep("HELP_WANTED", v);
                await stepper.goTo("expertise");
              } catch (e) {
                setError(e instanceof Error ? e.message : "Save failed");
              }
            })}
          >
            <h2>Help wanted</h2>
            <p className="wlth-muted">Select up to three</p>
            <div className="wlth-check-grid">
              {refData.helpWantedOptions.map((o) => {
                const selected = helpForm.watch("helpWanted") || [];
                return (
                  <label key={o.code} className="wlth-check">
                    <input
                      type="checkbox"
                      checked={selected.includes(o.code)}
                      onChange={() =>
                        toggleMulti(selected, o.code, 3, (next) =>
                          helpForm.setValue("helpWanted", next)
                        )
                      }
                    />
                    <span>{o.label}</span>
                  </label>
                );
              })}
            </div>
            <div className="wlth-field">
              <label htmlFor="hc">Optional context</label>
              <textarea id="hc" rows={2} {...helpForm.register("helpWantedContext")} />
            </div>
            <div className="wlth-actions">
              <button type="submit" className="wlth-btn-primary">
                Continue
              </button>
            </div>
          </form>
        )}

        {stepper.is("expertise") && (
          <form
            onSubmit={expertiseForm.handleSubmit(async (v) => {
              setError(null);
              try {
                await saveStep("EXPERTISE", v);
                await stepper.goTo("connection");
              } catch (e) {
                setError(e instanceof Error ? e.message : "Save failed");
              }
            })}
          >
            <h2>Expertise offered</h2>
            <p className="wlth-muted">Select up to five</p>
            <div className="wlth-check-grid">
              {refData.expertiseOptions.map((o) => {
                const selected = expertiseForm.watch("expertiseOffered") || [];
                return (
                  <label key={o.code} className="wlth-check">
                    <input
                      type="checkbox"
                      checked={selected.includes(o.code)}
                      onChange={() =>
                        toggleMulti(selected, o.code, 5, (next) =>
                          expertiseForm.setValue("expertiseOffered", next)
                        )
                      }
                    />
                    <span>{o.label}</span>
                  </label>
                );
              })}
            </div>
            <div className="wlth-field">
              <label htmlFor="ec">Optional context</label>
              <textarea id="ec" rows={2} {...expertiseForm.register("expertiseContext")} />
            </div>
            <div className="wlth-actions">
              <button type="submit" className="wlth-btn-primary">
                Continue
              </button>
            </div>
          </form>
        )}

        {stepper.is("connection") && (
          <form
            onSubmit={connectionForm.handleSubmit(async (v) => {
              setError(null);
              try {
                await saveStep("CONNECTION", v);
                await finish();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Save failed");
              }
            })}
            noValidate
          >
            <h2>Connection preference</h2>
            <div className="wlth-field">
              <label htmlFor="ct">Which kind of connection would help you most?</label>
              <select id="ct" {...connectionForm.register("connectionType")}>
                <option value="">Select</option>
                {refData.connectionTypes.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
              <FieldError
                message={connectionForm.formState.errors.connectionType?.message as string}
              />
            </div>
            <div className="wlth-actions">
              <button type="submit" className="wlth-btn-primary" disabled={loading}>
                Finish
              </button>
            </div>
          </form>
        )}

        {stepper.is("done") && (
          <>
            <h1>Welcome</h1>
            <p>Redirecting you home…</p>
          </>
        )}
      </div>
    </div>
  );
}
