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
import { captureAttribution } from "../../shared/attribution";
import {
  AnimatedLoader,
  type AnimationVariant,
} from "../../shared/AnimatedLoader";

type SignupAsyncState =
  | { kind: "idle" }
  | { kind: "loading-form" }
  | {
      kind: "busy";
      variant: AnimationVariant;
      title: string;
      description?: string;
    };

const BUSY = {
  saving: {
    kind: "busy" as const,
    variant: "walking" as const,
    title: "Saving your progress…",
    description: "Your answers are being added securely to your profile.",
  },
  next: {
    kind: "busy" as const,
    variant: "walking" as const,
    title: "Preparing your next step…",
    description: "You’re making great progress.",
  },
  account: {
    kind: "busy" as const,
    variant: "walking" as const,
    title: "Creating your account…",
    description: "Setting up your WLTH WLKS profile.",
  },
  /** Leaving for Stripe — single payment-verification Lottie only */
  checkout: {
    kind: "busy" as const,
    variant: "payment-verification" as const,
    title: "Taking you to secure checkout…",
    description: "Stripe is opening so you can complete your membership payment.",
  },
  /**
   * Back from Stripe — single payment-confirmed Lottie for the whole wait
   * (shown even while server is still confirming).
   */
  paymentReturn: {
    kind: "busy" as const,
    variant: "payment-confirmed" as const,
    title: "Payment confirmed",
    description:
      "We’re finishing setup with Stripe. This usually takes only a moment.",
  },
  finish: {
    kind: "busy" as const,
    variant: "walking" as const,
    title: "Finishing your profile…",
    description: "We’re preparing your WLTH WLKS membership experience.",
  },
  redirect: {
    kind: "busy" as const,
    variant: "walking" as const,
    title: "Taking you to WLTH WLKS…",
    description: "Almost there.",
  },
};

/** Scroll the embed (and window) so the form top is in view after step changes. */
function scrollSignupToTop() {
  try {
    const root =
      document.getElementById("wlth-signup-root") ||
      document.querySelector(".wlth-widget");
    if (root) {
      root.scrollIntoView({ behavior: "smooth", block: "start" });
      const rect = root.getBoundingClientRect();
      const y = window.scrollY + rect.top - 12;
      window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  } catch {
    try {
      window.scrollTo(0, 0);
    } catch {
      /* ignore */
    }
  }
}

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
  help: "Matching",
  expertise: "Matching",
  connection: "Matching",
  done: "Done",
};

const MATCHING_STEPS = ["goal", "help", "expertise", "connection"] as const;

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

/** Top-level progress phases (Matching covers goal→connection). */
const FLOW_DOTS = ["account", "location", "business", "payment", "matching"] as const;

function topPhaseForStep(stepId: string): (typeof FLOW_DOTS)[number] | null {
  if (stepId === "account" || stepId === "location" || stepId === "business" || stepId === "payment") {
    return stepId;
  }
  if (MATCHING_STEPS.includes(stepId as (typeof MATCHING_STEPS)[number]) || stepId === "success") {
    return "matching";
  }
  return null;
}

function matchingSubIndex(stepId: string): number {
  const i = MATCHING_STEPS.indexOf(stepId as (typeof MATCHING_STEPS)[number]);
  return i >= 0 ? i + 1 : 0;
}

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
  const [asyncState, setAsyncState] = useState<SignupAsyncState>({
    kind: "loading-form",
  });
  const [refData, setRefData] = useState<RefData | null>(null);
  const [config, setConfig] = useState<{
    membershipPriceId: string;
    homeUrl: string;
  } | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const attribution = useMemo(() => captureAttribution(), []);
  const busy = asyncState.kind === "busy" || asyncState.kind === "loading-form";
  const loading = busy; // alias for disabled buttons

  const clearCheckoutFlags = () => {
    try {
      sessionStorage.removeItem("wlth_checkout_pending");
      sessionStorage.removeItem("wlth_checkout_started_at");
      sessionStorage.removeItem("wlth_payment_ok"); // legacy — never treat as payment proof
    } catch {
      /* ignore */
    }
  };

  /**
   * After Stripe return: server verifies checkout + links Stripe Customer ID by Memberstack ID,
   * then polls until Airtable shows Paid/Active. Client never asserts Paid itself.
   */
  const confirmPaymentFromServer = async (accessToken: string | null) => {
    // One Lottie only for the whole return path (payment-confirmed)
    setAsyncState(BUSY.paymentReturn);
    setError(null);
    scrollSignupToTop();

    if (!accessToken) {
      setAsyncState({ kind: "idle" });
      setError("Please stay signed in while we confirm your payment.");
      await stepper.goTo("payment");
      scrollSignupToTop();
      clearPaymentQueryParam();
      clearCheckoutFlags();
      return;
    }

    void api(props.apiBase, "/api/onboarding/analytics", {
      method: "POST",
      token: accessToken,
      body: JSON.stringify({ eventType: "PAYMENT_RETURNED" }),
    }).catch(() => undefined);

    const params = new URLSearchParams(window.location.search);
    const sessionId =
      params.get("session_id") ||
      params.get("checkout_session_id") ||
      params.get("cs_id") ||
      "";

    try {
      await api(props.apiBase, "/api/onboarding/confirm-checkout", {
        method: "POST",
        token: accessToken,
        body: JSON.stringify(sessionId ? { sessionId } : {}),
      });
    } catch {
      /* continue to poll */
    }

    const maxAttempts = 15;
    const delayMs = 2000;
    let confirmed = false;
    let cancelled = false;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        if (i > 0 && i % 3 === 0) {
          await api(props.apiBase, "/api/onboarding/confirm-checkout", {
            method: "POST",
            token: accessToken,
            body: JSON.stringify(sessionId ? { sessionId } : {}),
          }).catch(() => undefined);
        }
        const st = await api(props.apiBase, "/api/onboarding/payment-status", {
          token: accessToken,
        });
        if (st.paymentConfirmed) {
          confirmed = true;
          break;
        }
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, delayMs));
    }

    clearPaymentQueryParam();
    clearCheckoutFlags();

    if (confirmed) {
      // Brief hold on the same payment-confirmed state, then matching form
      await new Promise((r) => setTimeout(r, 700));
      markPreGoalComplete(stepper);
      await stepper.goTo("goal");
      setAsyncState({ kind: "idle" });
      scrollSignupToTop();
    } else if (!cancelled) {
      setAsyncState({ kind: "idle" });
      setError(
        "We’re still confirming your payment with Stripe. Your progress is saved — refresh this page in a moment, or continue when you’re ready."
      );
      await stepper.goTo("payment");
      scrollSignupToTop();
    }
  };

  /** Resume from Airtable onboarding status only (no stale checkout flags). */
  const resumeFromStatus = async (accessToken: string) => {
    const status = await api(props.apiBase, "/api/onboarding/status", {
      token: accessToken,
    });
    const resume = resumeStageToStep(
      String(status.resumeStage || ""),
      Boolean(status.paymentConfirmed)
    );
    if (!resume || resume === "account") return;
    if (
      resume === "goal" ||
      resume === "help" ||
      resume === "expertise" ||
      resume === "connection" ||
      resume === "done"
    ) {
      markPreGoalComplete(stepper);
    } else if (resume === "payment") {
      stepper.setComplete("account" as never);
      stepper.setComplete("location" as never);
      stepper.setComplete("business" as never);
    } else if (resume === "business") {
      stepper.setComplete("account" as never);
      stepper.setComplete("location" as never);
    } else if (resume === "location") {
      stepper.setComplete("account" as never);
    }
    await stepper.goTo(resume as never);
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
        // leave loading-form until mount path finishes
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
        // Only treat Stripe return when we also started checkout recently (avoids random session_id)
        let checkoutPending = false;
        let checkoutFresh = false;
        try {
          checkoutPending = sessionStorage.getItem("wlth_checkout_pending") === "1";
          const startedAt = Number(sessionStorage.getItem("wlth_checkout_started_at") || "0");
          checkoutFresh = checkoutPending && startedAt > 0 && Date.now() - startedAt < 2 * 60 * 60 * 1000;
        } catch {
          /* ignore */
        }
        // Drop legacy flag that previously forced every reload onto Payment
        try {
          sessionStorage.removeItem("wlth_payment_ok");
        } catch {
          /* ignore */
        }

        const explicitPaySuccess =
          paymentReturn === "success" ||
          (Boolean(params.get("session_id")) && checkoutFresh);

        if (explicitPaySuccess && checkoutFresh) {
          await confirmPaymentFromServer(t);
        } else if (paymentReturn === "cancel") {
          clearCheckoutFlags();
          clearPaymentQueryParam();
          if (t) {
            try {
              await resumeFromStatus(t);
            } catch {
              await stepper.goTo("payment");
            }
          } else {
            await stepper.goTo("payment");
          }
        } else if (checkoutFresh && t) {
          // Returned from Stripe without our query param (some MS/Stripe configs strip it)
          await confirmPaymentFromServer(t);
        } else {
          // Normal visit / resume — never jump to Payment from stale flags
          if (checkoutPending && !checkoutFresh) clearCheckoutFlags();
          if (t) {
            try {
              await resumeFromStatus(t);
            } catch {
              // stay on account
            }
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

        // Payment checkout/return owns busy until it finishes
        setAsyncState((s) =>
          s.kind === "busy" &&
          (s.variant === "payment-verification" ||
            s.variant === "payment-confirmed")
            ? s
            : { kind: "idle" }
        );
        scrollSignupToTop();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load form");
        setAsyncState({ kind: "idle" });
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
    if (busy) return;
    setError(null);
    setAsyncState(BUSY.account);
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
      setAsyncState(BUSY.saving);

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

      setAsyncState(BUSY.next);
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
        hasMessage: e instanceof Error && Boolean(e.message),
      });
      setError(e instanceof Error ? e.message : "Account step failed");
    } finally {
      setAsyncState({ kind: "idle" });
      scrollSignupToTop();
    }
  });

  const onLocation = locationForm.handleSubmit(async (values) => {
    setError(null);
    setAsyncState(BUSY.saving);
    try {
      await saveStep("LOCATION", values);
      setAsyncState(BUSY.next);
      stepper.setComplete("location");
      await stepper.next();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Location save failed");
    } finally {
      setAsyncState({ kind: "idle" });
      scrollSignupToTop();
    }
  });

  const onBusiness = businessForm.handleSubmit(async (values) => {
    setError(null);
    setAsyncState(BUSY.saving);
    try {
      await saveStep("BUSINESS", values);
      await saveStep("PAYMENT_PENDING", {});
      setAsyncState(BUSY.next);
      stepper.setComplete("business");
      await stepper.next();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Business save failed");
    } finally {
      setAsyncState({ kind: "idle" });
      scrollSignupToTop();
    }
  });

  const startCheckout = async () => {
    setError(null);
    // Single Lottie outbound — payment-verification only (no walking first)
    setAsyncState(BUSY.checkout);
    scrollSignupToTop();
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
      setAsyncState({ kind: "idle" });
      return;
    }
    if (!w.$memberstackDom?.purchasePlansWithCheckout) {
      setError("Memberstack checkout is unavailable on this page.");
      setAsyncState({ kind: "idle" });
      return;
    }
    const base = window.location.origin + window.location.pathname;
    try {
      sessionStorage.setItem("wlth_checkout_pending", "1");
      sessionStorage.setItem("wlth_checkout_started_at", String(Date.now()));
      sessionStorage.removeItem("wlth_payment_ok");
    } catch {
      /* ignore */
    }
    await api(props.apiBase, "/api/onboarding/analytics", {
      method: "POST",
      body: JSON.stringify({ eventType: "CHECKOUT_STARTED" }),
    }).catch(() => undefined);
    try {
      await w.$memberstackDom.purchasePlansWithCheckout({
        priceId,
        successUrl: `${base}?payment=success`,
        cancelUrl: `${base}?payment=cancel`,
      });
      let t = token;
      if (!t) t = await tryResolveSessionAccessToken();
      if (t) setToken(t);
      await confirmPaymentFromServer(t);
    } catch (e) {
      try {
        sessionStorage.removeItem("wlth_checkout_pending");
      } catch {
        /* ignore */
      }
      const msg = e instanceof Error ? e.message : "";
      if (msg && !/cancel|closed|abort/i.test(msg)) {
        setError(msg);
      }
      setAsyncState({ kind: "idle" });
    }
  };

  const finish = async () => {
    setError(null);
    // End of flow: walking woman only
    setAsyncState(BUSY.finish);
    scrollSignupToTop();
    try {
      if (token) {
        await api(props.apiBase, "/api/onboarding/complete", {
          method: "POST",
          token,
        });
      }
      setAsyncState(BUSY.redirect);
      // Keep loader visible until navigation unloads the page — do not clear loading
      window.location.assign(config?.homeUrl || "https://wlthwlks.com");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete");
      setAsyncState({ kind: "idle" });
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

  if (asyncState.kind === "loading-form") {
    return (
      <div className="wlth-widget">
        <div className="wlth-card wlth-overlay-load">
          <AnimatedLoader
            variant="walking"
            title="Preparing your WLTH WLKS journey…"
            description="Loading everything you need to get started."
            size="large"
            fullScreen
          />
        </div>
      </div>
    );
  }

  if (asyncState.kind === "busy") {
    return (
      <div className="wlth-widget">
        <div className="wlth-card wlth-overlay-load">
          <AnimatedLoader
            variant={asyncState.variant}
            title={asyncState.title}
            description={asyncState.description}
            size={
              asyncState.variant === "payment-verification" ||
              asyncState.variant === "payment-confirmed"
                ? "large"
                : "medium"
            }
            fullScreen
          />
        </div>
      </div>
    );
  }

  if (!refData) {
    return (
      <div className="wlth-widget">
        <div className="wlth-card">
          {error ? (
            <div className="wlth-banner-error">{error}</div>
          ) : (
            <AnimatedLoader
              variant="walking"
              title="Preparing your WLTH WLKS journey…"
              size="large"
              fullScreen
            />
          )}
        </div>
      </div>
    );
  }

  const currentStepId = String(
    (stepper as { state?: { current?: { id?: string } } }).state?.current?.id ||
      FLOW_DOTS.find((id) => id !== "matching" && stepper.is(id as never)) ||
      (MATCHING_STEPS.find((id) => stepper.is(id as never)) ?? "account")
  );
  const activePhase = topPhaseForStep(currentStepId) || "account";
  const matchSub = matchingSubIndex(currentStepId);
  const phaseIndex = Math.max(0, FLOW_DOTS.indexOf(activePhase));
  const progressPct = Math.round(((phaseIndex + (matchSub ? matchSub / 4 : 0.5)) / FLOW_DOTS.length) * 100);

  return (
    <div className="wlth-widget">
      <div className="wlth-card">
        <div className="wlth-progress" aria-hidden>
          <span style={{ width: `${Math.min(100, progressPct)}%` }} />
        </div>
        <div className="wlth-steps" aria-label="Progress">
          {FLOW_DOTS.map((id, idx) => {
            const label =
              id === "matching"
                ? "Matching"
                : id === "account"
                  ? "Account"
                  : id === "location"
                    ? "Location"
                    : id === "business"
                      ? "Business"
                      : "Payment";
            const isActive = activePhase === id;
            const isDone = idx < phaseIndex || (id === "matching" && matchSub > 0 && !isActive);
            return (
              <span
                key={id}
                className={`wlth-step-dot ${isActive ? "is-active" : isDone ? "is-done" : ""}`}
              >
                {label}
              </span>
            );
          })}
        </div>
        {matchSub > 0 && (
          <p className="wlth-subprogress">
            Matching · {matchSub} of 4
          </p>
        )}

        {error && (
          <div className="wlth-banner-error" role="alert">
            {error}
          </div>
        )}

        {stepper.is("account") && (
          <form className="wlth-step-panel" key="account" onSubmit={onAccount} noValidate>
            <h1>Join WLTH WLKS</h1>
            <p>Create your account to continue.</p>
            <div className="wlth-grid-2">
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
              <button type="submit" className="wlth-btn-primary" disabled={busy}>
                Continue
              </button>
            </div>
          </form>
        )}

        {stepper.is("location") && (
          <form className="wlth-step-panel" key="location" onSubmit={onLocation} noValidate>
            <h2>Where are you based?</h2>
            <div className="wlth-grid-2">
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
              <button type="submit" className="wlth-btn-primary" disabled={busy}>
                Continue
              </button>
            </div>
          </form>
        )}

        {stepper.is("business") && (
          <form className="wlth-step-panel" key="business" onSubmit={onBusiness} noValidate>
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
              <button type="submit" className="wlth-btn-primary" disabled={busy}>
                Continue to payment
              </button>
            </div>
          </form>
        )}

        {stepper.is("payment") && (
          <div className="wlth-pay-hero wlth-step-panel" key="payment">
            <h1>Your WLTH WLKS membership starts here</h1>
            <p>
              Complete your secure payment through Stripe and unlock a more intentional way to
              build valuable founder connections.
            </p>
            <div className="wlth-benefits">
              <p className="wlth-benefit">
                <strong>Curated introductions</strong>
                Shaped by your goals, business stage, and availability.
              </p>
              <p className="wlth-benefit">
                <strong>Relevant connections</strong>
                Meet founders in your community who are building too.
              </p>
              <p className="wlth-benefit">
                <strong>Ongoing growth</strong>
                Opportunities to learn, collaborate, and stay accountable.
              </p>
              <p className="wlth-benefit">
                <strong>A living profile</strong>
                Matching improves as your priorities evolve.
              </p>
            </div>
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                disabled={busy}
                onClick={() => void startCheckout()}
              >
                Continue to secure checkout
              </button>
            </div>
            <p className="wlth-trust">
              Secure payment powered by Stripe. You can cancel anytime from your membership
              settings. We never store your full card details on WLTH WLKS.
            </p>
          </div>
        )}

        {stepper.is("success") && (
          <div className="wlth-step-panel" key="success">
            <h1>You’re in!</h1>
            <p>Next: a few questions so we can improve your matching results.</p>
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                onClick={() => void stepper.goTo("goal")}
              >
                Continue to matching
              </button>
              <button
                type="button"
                className="wlth-btn-secondary"
                onClick={() => void finish()}
              >
                Go to home
              </button>
            </div>
          </div>
        )}

        {stepper.is("goal") && (
          <form
            className="wlth-step-panel"
            key="goal"
            onSubmit={goalForm.handleSubmit(async (v) => {
              setError(null);
              setAsyncState(BUSY.saving);
              try {
                await saveStep("GOAL", v);
                setAsyncState(BUSY.next);
                await stepper.goTo("help");
              } catch (e) {
                setError(e instanceof Error ? e.message : "Save failed");
              } finally {
                setAsyncState({ kind: "idle" });
                scrollSignupToTop();
              }
            })}
            noValidate
          >
            <h2>Improve your matching results</h2>
            <p className="wlth-muted">
              Your answers help us introduce you to the right people — they never change how
              matching algorithms run outside this profile.
            </p>
            <div className="wlth-field">
              <label htmlFor="goal">
                What is your most important goal for the next 90 days?
              </label>
              <textarea id="goal" rows={4} {...goalForm.register("ninetyDayGoal")} />
              <FieldError message={goalForm.formState.errors.ninetyDayGoal?.message as string} />
            </div>
            <div className="wlth-actions">
              <button type="submit" className="wlth-btn-primary" disabled={busy}>
                Continue
              </button>
            </div>
          </form>
        )}

        {stepper.is("help") && (
          <form
            className="wlth-step-panel"
            key="help"
            onSubmit={helpForm.handleSubmit(async (v) => {
              setError(null);
              setAsyncState(BUSY.saving);
              try {
                await saveStep("HELP_WANTED", v);
                setAsyncState(BUSY.next);
                await stepper.goTo("expertise");
              } catch (e) {
                setError(e instanceof Error ? e.message : "Save failed");
              } finally {
                setAsyncState({ kind: "idle" });
                scrollSignupToTop();
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
              <button type="submit" className="wlth-btn-primary" disabled={busy}>
                Continue
              </button>
            </div>
          </form>
        )}

        {stepper.is("expertise") && (
          <form
            className="wlth-step-panel"
            key="expertise"
            onSubmit={expertiseForm.handleSubmit(async (v) => {
              setError(null);
              setAsyncState(BUSY.saving);
              try {
                await saveStep("EXPERTISE", v);
                setAsyncState(BUSY.next);
                await stepper.goTo("connection");
              } catch (e) {
                setError(e instanceof Error ? e.message : "Save failed");
              } finally {
                setAsyncState({ kind: "idle" });
                scrollSignupToTop();
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
              <button type="submit" className="wlth-btn-primary" disabled={busy}>
                Continue
              </button>
            </div>
          </form>
        )}

        {stepper.is("connection") && (
          <form
            className="wlth-step-panel"
            key="connection"
            onSubmit={connectionForm.handleSubmit(async (v) => {
              setError(null);
              setAsyncState(BUSY.saving);
              try {
                await saveStep("CONNECTION", v);
                // finish() keeps walking loader until redirect — never re-show this step
                await finish();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Save failed");
                setAsyncState({ kind: "idle" });
                scrollSignupToTop();
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
              <button type="submit" className="wlth-btn-primary" disabled={busy}>
                Finish
              </button>
            </div>
          </form>
        )}

        {stepper.is("done") && (
          <div className="wlth-step-panel" key="done">
            <h1>Welcome</h1>
            <p>Redirecting you home…</p>
          </div>
        )}
      </div>
    </div>
  );
}
