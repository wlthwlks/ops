import { useEffect, useMemo, useRef, useState } from "react";
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
  AGE_RANGES,
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
import { trackAbleAuth, trackAbleLead } from "../../shared/able-tracking";
import {
  AnimatedLoader,
  type AnimationVariant,
} from "../../shared/AnimatedLoader";
import {
  PhoneField,
  dialCodeForCountryCode,
  iso2ForCountryCode,
} from "../../shared/PhoneField";
import {
  BusinessFields,
  CommunityIntentionCard,
  ConnectionTypeField,
  FieldError,
  LocationFields,
  MatchingGoalField,
} from "../../shared/form-fields";
import { MultiSelectDropdown } from "../../shared/MultiSelectDropdown";
import { markSignupSessionRefreshComplete } from "../../shared/session-refresh-gate";
import { runOutboundCheckout } from "../../shared/checkout-outbound";
import { onInvalidScrollToError, scrollWidgetToTop } from "../../shared/form-scroll";
import {
  clearAwaitingPostPaymentMatching,
  clearSignupFlowMarker,
  hasActiveSignupFlowForMember,
  isAwaitingPostPaymentMatching,
  markAwaitingPostPaymentMatching,
  setSignupFlowMarker,
} from "../../shared/signup-flow-marker";
import { decodeJwtPayload } from "../../shared/session-refresh-gate";
import {
  ADDABLE_SOCIAL_PLATFORMS,
  SOCIAL_PLATFORM_LABELS,
  type SocialLink,
  type SocialPlatform,
  displayUrl,
  normalizeSocialUrl,
} from "../../shared/profile-urls";

export { runOutboundCheckout } from "../../shared/checkout-outbound";

function memberIdFromAccessToken(token: string | null | undefined): string {
  if (!token) return "";
  const p = decodeJwtPayload(token);
  if (p && typeof p.sub === "string") return p.sub.trim();
  if (p && typeof p.id === "string") return p.id.trim();
  return "";
}

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
    description: "You’re making thoughtful progress.",
  },
  account: {
    kind: "busy" as const,
    variant: "walking" as const,
    title: "Creating your account…",
    description: "Setting up your WLTH WLKS profile.",
  },
  /** Leaving for Stripe — payment-verification only until navigation or cancel */
  checkout: {
    kind: "busy" as const,
    variant: "payment-verification" as const,
    title: "Taking you to secure checkout…",
    description: "Stripe is opening so you can complete your membership payment.",
  },
  /**
   * Back from Stripe while we verify — never claim success until server confirms.
   * (False "Payment confirmed" confuses customers who pressed Back / cancelled.)
   */
  paymentReturn: {
    kind: "busy" as const,
    variant: "payment-verification" as const,
    title: "Checking your payment…",
    description:
      "We’re confirming the status with Stripe. This usually takes only a moment.",
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

function scrollSignupToTop() {
  scrollWidgetToTop("wlth-signup-root");
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

const MATCHING_STEPS = ["goal", "help", "expertise", "connection"] as const;

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

const FLOW_DOTS = ["account", "location", "business", "payment", "matching"] as const;

function topPhaseForStep(stepId: string): (typeof FLOW_DOTS)[number] | null {
  if (
    stepId === "account" ||
    stepId === "location" ||
    stepId === "business" ||
    stepId === "payment"
  ) {
    return stepId;
  }
  if (
    MATCHING_STEPS.includes(stepId as (typeof MATCHING_STEPS)[number]) ||
    stepId === "success"
  ) {
    return "matching";
  }
  return null;
}

function matchingSubIndex(stepId: string): number {
  const i = MATCHING_STEPS.indexOf(stepId as (typeof MATCHING_STEPS)[number]);
  return i >= 0 ? i + 1 : 0;
}

type RefData = {
  countries: Array<{
    code: string;
    label: string;
    iso2?: string | null;
    dialCode?: string | null;
  }>;
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

export function SignupApp(props: { apiBase: string }) {
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
  const [communityOk, setCommunityOk] = useState(false);
  const [communityError, setCommunityError] = useState<string | undefined>();
  const [termsOk, setTermsOk] = useState(false);
  const [termsError, setTermsError] = useState<string | undefined>();
  const [promoCode, setPromoCode] = useState("");
  const [promoApplied, setPromoApplied] = useState<{
    offerCode: string;
    priceKey: string;
    memberstackPriceId: string;
    label: string | null;
    description: string | null;
  } | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);
  const mountedRef = useRef(true);
  const attribution = useMemo(() => captureAttribution(), []);
  const busy = asyncState.kind === "busy" || asyncState.kind === "loading-form";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearCheckoutFlags = () => {
    try {
      sessionStorage.removeItem("wlth_checkout_pending");
      sessionStorage.removeItem("wlth_checkout_started_at");
      sessionStorage.removeItem("wlth_payment_ok");
    } catch {
      /* ignore */
    }
  };

  /**
   * Stripe-return path only: show verification loader and verify server-side.
   * Never call from outbound startCheckout. Never show "payment confirmed" until paid.
   */
  const confirmPaymentFromServer = async (accessToken: string | null) => {
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

    let lastConfirmReason = "";
    let lastConfirmStatus = "";
    try {
      const conf = await api(props.apiBase, "/api/onboarding/confirm-checkout", {
        method: "POST",
        token: accessToken,
        body: JSON.stringify(sessionId ? { sessionId } : {}),
      });
      if (conf.paymentConfirmed) {
        clearPaymentQueryParam();
        clearCheckoutFlags();
        clearAwaitingPostPaymentMatching();
        await new Promise((r) => setTimeout(r, 700));
        markPreGoalComplete(stepper);
        await stepper.goTo("goal");
        setAsyncState({ kind: "idle" });
        scrollSignupToTop();
        return;
      }
      lastConfirmReason = String(conf.reason || "");
      lastConfirmStatus = String(conf.status || "");
    } catch {
      /* continue to poll */
    }

    // Poll like update-details subscribe-again: confirm every few ticks + payment-status.
    const maxAttempts = 15;
    const delayMs = 2000;
    let confirmed = false;
    for (let i = 0; i < maxAttempts; i++) {
      if (!mountedRef.current) return;
      try {
        // First attempts + every 3rd: re-hit confirm-checkout (Stripe lag).
        if (i === 0 || i % 3 === 0) {
          const conf = await api(props.apiBase, "/api/onboarding/confirm-checkout", {
            method: "POST",
            token: accessToken,
            body: JSON.stringify(sessionId ? { sessionId } : {}),
          }).catch(() => null);
          if (conf?.paymentConfirmed) {
            confirmed = true;
            break;
          }
          if (conf?.reason) lastConfirmReason = String(conf.reason);
          if (conf?.status) lastConfirmStatus = String(conf.status);
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
    if (!mountedRef.current) return;

    if (confirmed) {
      clearAwaitingPostPaymentMatching();
      await new Promise((r) => setTimeout(r, 700));
      markPreGoalComplete(stepper);
      await stepper.goTo("goal");
      setAsyncState({ kind: "idle" });
      scrollSignupToTop();
    } else {
      setAsyncState({ kind: "idle" });
      // Never surface internal server reasons like "Linked Stripe Customer ID…".
      const configHint =
        lastConfirmStatus === "membership_price_config_missing"
          ? " Membership price configuration is incomplete; contact support if this continues."
          : lastConfirmStatus === "stripe_customer_ambiguous"
            ? " We found multiple billing profiles for this email; contact support."
            : lastConfirmStatus === "session_ownership_mismatch" ||
                lastConfirmStatus === "stripe_customer_conflict"
              ? " We couldn't securely match this checkout to your account; contact support."
              : "";
      const softPending =
        lastConfirmStatus === "customer_linked_payment_pending" ||
        lastConfirmStatus === "session_not_paid" ||
        lastConfirmStatus === "stripe_customer_unresolved" ||
        lastConfirmStatus === "session_price_not_membership" ||
        !lastConfirmStatus;
      setError(
        (softPending
          ? "We're still confirming your payment with Stripe. Your progress is saved — stay on Payment and try Continue again, or refresh in a moment."
          : lastConfirmReason &&
              lastConfirmReason.length < 180 &&
              !/linked stripe customer/i.test(lastConfirmReason)
            ? lastConfirmReason
            : "We're still confirming your payment with Stripe. Your progress is saved; refresh this page in a moment, or continue when you're ready.") +
          configHint
      );
      await stepper.goTo("payment");
      scrollSignupToTop();
    }
  };

  const resumeFromStatus = async (accessToken: string) => {
    const status = await api(props.apiBase, "/api/onboarding/status", {
      token: accessToken,
    });
    const paid = Boolean(status.paymentConfirmed);
    let resume = resumeStageToStep(String(status.resumeStage || ""), paid);

    // Paid + still in signup flow → Matching even if status lag says Payment
    const mid = memberIdFromAccessToken(accessToken);
    if (
      paid &&
      resume &&
      (resume === "payment" || resume === "business" || resume === "location")
    ) {
      const onboarding = String(status.onboardingStatus || "").toUpperCase();
      if (
        onboarding === "BUSINESS" ||
        onboarding === "PAYMENT_PENDING" ||
        onboarding === "PAYMENT_CONFIRMED" ||
        isAwaitingPostPaymentMatching(mid)
      ) {
        resume = "goal";
      }
    }
    if (paid && isAwaitingPostPaymentMatching(mid)) {
      resume = resume && MATCHING_STEPS.includes(resume as (typeof MATCHING_STEPS)[number])
        ? resume
        : "goal";
      clearAwaitingPostPaymentMatching();
    }

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
    defaultValues: {
      firstName: "",
      lastName: "",
      age: "",
      email: "",
      password: "",
    },
    mode: "onBlur",
  });
  const locationForm = useForm<LocationForm>({
    resolver: zodResolver(locationFormSchema),
    defaultValues: {
      countryCode: "",
      cityCode: "",
      countryIso2: "",
      postCode: "",
      phone: "",
      phonePrefix: "",
      availability: [],
    },
    mode: "onBlur",
  });
  const businessForm = useForm<BusinessForm>({
    resolver: zodResolver(businessFormSchema),
    defaultValues: {
      primaryIndustry: "",
      otherIndustry: "",
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

  const [socialLinks, setSocialLinks] = useState<SocialLink[]>([]);
  const [socialLinksErrors, setSocialLinksErrors] = useState<string[]>([]);
  const [socialError, setSocialError] = useState("");
  const [addingSocialPlatform, setAddingSocialPlatform] = useState(false);

  const addSocialLink = (platform: SocialPlatform) => {
    if (socialLinks.some((l) => l.platform === platform)) {
      setSocialError("This platform is already added.");
      return;
    }
    setSocialLinks([...socialLinks, { platform, url: "" }]);
    setSocialLinksErrors([...socialLinksErrors, ""]);
    setSocialError("");
    setAddingSocialPlatform(false);
  };

  const updateSocialUrl = (index: number, url: string) => {
    const next = [...socialLinks];
    next[index] = { ...next[index], url };
    setSocialLinks(next);
  };

  const removeSocialLink = (index: number) => {
    setSocialLinks(socialLinks.filter((_, i) => i !== index));
    setSocialLinksErrors(socialLinksErrors.filter((_, i) => i !== index));
    setSocialError("");
  };

  const countryCode = locationForm.watch("countryCode");
  const phonePrefix = locationForm.watch("phonePrefix");
  const primaryIndustry = businessForm.watch("primaryIndustry");
  const helpWanted = helpForm.watch("helpWanted") || [];
  const expertiseOffered = expertiseForm.watch("expertiseOffered") || [];

  const cities = useMemo(
    () => (refData?.cities || []).filter((c) => c.countryCode === countryCode),
    [refData, countryCode]
  );

  // Fixed phone prefix + ISO2 from selected country (not user-editable).
  useEffect(() => {
    if (!countryCode || !refData) {
      locationForm.setValue("phonePrefix", "");
      locationForm.setValue("countryIso2", "");
      return;
    }
    const dial = dialCodeForCountryCode(refData.countries, countryCode) || "";
    const iso2 = iso2ForCountryCode(refData.countries, countryCode) || "";
    if (dial !== phonePrefix) {
      locationForm.setValue("phonePrefix", dial, { shouldValidate: true });
    }
    locationForm.setValue("countryIso2", iso2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryCode, refData]);

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

        const t = await tryResolveSessionAccessToken();
        logMemberstackDiagnostics("session_resume", {
          tokenFound: Boolean(t),
          tokenType: t ? typeof t : "none",
        });
        if (t) {
          setToken(t);
          // Recover marker only if Stripe checkout is pending and marker was lost — never clear here
          try {
            const mid = memberIdFromAccessToken(t);
            const checkoutPending =
              sessionStorage.getItem("wlth_checkout_pending") === "1";
            if (mid && checkoutPending && !hasActiveSignupFlowForMember(mid)) {
              setSignupFlowMarker(mid);
            }
          } catch {
            /* ignore */
          }
        }

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
        // Memberstack often ignores successUrl/cancelUrl and returns with these instead.
        const fromCheckout = params.get("fromCheckout");
        const msStripePriceId = (params.get("stripePriceId") || "").trim();
        const msPriceId = (params.get("msPriceId") || "").trim();
        const memberstackReturned =
          fromCheckout !== null || msStripePriceId !== "" || msPriceId !== "";
        // stripePriceId=price_… is present only after a successful Memberstack payment.
        const memberstackPaid =
          memberstackReturned && msStripePriceId.startsWith("price_");
        let checkoutPending = false;
        let checkoutFresh = false;
        try {
          checkoutPending = sessionStorage.getItem("wlth_checkout_pending") === "1";
          const startedAt = Number(sessionStorage.getItem("wlth_checkout_started_at") || "0");
          checkoutFresh =
            checkoutPending && startedAt > 0 && Date.now() - startedAt < 2 * 60 * 60 * 1000;
        } catch {
          /* ignore */
        }
        try {
          sessionStorage.removeItem("wlth_payment_ok");
        } catch {
          /* ignore */
        }

        const hasSessionId = Boolean(
          params.get("session_id") ||
            params.get("checkout_session_id") ||
            params.get("cs_id")
        );
        // Explicit paid return — do NOT require sessionStorage (often lost on redirect).
        // Memberstack may return stripePriceId=price_… after a real charge.
        const explicitPaySuccess =
          paymentReturn === "success" ||
          memberstackPaid ||
          (hasSessionId && paymentReturn !== "cancel");
        // Only treat explicit cancel as cancel — never treat ambiguous Memberstack
        // returns as cancel (that blocked successful payments from reaching Matching).
        const explicitPayCancel = paymentReturn === "cancel";

        const mid = t ? memberIdFromAccessToken(t) : "";
        const awaitingMatching =
          Boolean(mid) && isAwaitingPostPaymentMatching(mid);

        if (explicitPayCancel) {
          clearCheckoutFlags();
          clearPaymentQueryParam();
          // Keep awaiting flag so they can retry checkout; resume to payment
          if (t) {
            try {
              await resumeFromStatus(t);
            } catch {
              await stepper.goTo("payment");
            }
          } else {
            await stepper.goTo("payment");
          }
          try {
            const url = new URL(window.location.href);
            url.searchParams.delete("fromCheckout");
            url.searchParams.delete("stripePriceId");
            url.searchParams.delete("msPriceId");
            url.searchParams.delete("forceRefetch");
            window.history.replaceState({}, "", url.pathname + url.search);
          } catch {
            /* ignore */
          }
        } else if (explicitPaySuccess && t) {
          // Always confirm + go Matching on successful return (even if session flags gone)
          await confirmPaymentFromServer(t);
        } else if (
          (checkoutFresh || awaitingMatching || memberstackReturned) &&
          t &&
          !explicitPayCancel
        ) {
          /**
           * Stripe sometimes strips query params. Only auto-confirm when we have
           * checkout intent AND server says payment stage or later (or paid).
           * Never jump Location → Payment on a plain hard refresh.
           */
          let resumeStage = "";
          let paid = false;
          try {
            const st = await api(props.apiBase, "/api/onboarding/status", {
              token: t,
            });
            resumeStage = String(st.resumeStage || "");
            paid = Boolean(st.paymentConfirmed);
          } catch {
            /* ignore */
          }
          const atOrPastPayment =
            paid ||
            resumeStage === "PAYMENT_PENDING" ||
            resumeStage === "PAYMENT_CONFIRMED" ||
            resumeStage === "GOAL" ||
            resumeStage === "HELP_WANTED" ||
            resumeStage === "EXPERTISE" ||
            resumeStage === "CONNECTION" ||
            resumeStage === "COMPLETE" ||
            awaitingMatching;
          if (atOrPastPayment) {
            if (paid) {
              clearCheckoutFlags();
              clearAwaitingPostPaymentMatching();
              markPreGoalComplete(stepper);
              await stepper.goTo("goal");
            } else {
              await confirmPaymentFromServer(t);
            }
          } else {
            clearCheckoutFlags();
            try {
              await resumeFromStatus(t);
            } catch {
              /* stay on account */
            }
          }
        } else {
          if (checkoutPending && !checkoutFresh) clearCheckoutFlags();
          if (t) {
            try {
              await resumeFromStatus(t);
            } catch {
              /* stay on account */
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

        setAsyncState((s) =>
          s.kind === "busy" &&
          (s.variant === "payment-verification" || s.variant === "payment-confirmed")
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

  const onAccount = accountForm.handleSubmit(
    async (values) => {
    if (busy) return;
    setError(null);
    setAsyncState(BUSY.account);
    scrollSignupToTop();

    void api(props.apiBase, "/api/onboarding/analytics", {
      method: "POST",
      body: JSON.stringify({
        eventType: "ACCOUNT_STARTED",
        utm_source: attribution.utm_source,
        utm_medium: attribution.utm_medium,
        utm_campaign: attribution.utm_campaign,
      }),
    }).catch(() => undefined);

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
      // Bind /apply stay-marker to this member — survives Stripe redirect
      const mid =
        (auth.memberId || "").trim() || memberIdFromAccessToken(auth.accessToken);
      if (mid) setSignupFlowMarker(mid);

      // Able CDP: Lead + Auth only for genuine new Memberstack signups (before bootstrap).
      if (auth.source === "signup") {
        trackAbleLead({
          email: values.email,
          memberId: mid,
          firstName: values.firstName,
          lastName: values.lastName,
        });
        trackAbleAuth({
          email: values.email,
          memberId: mid,
        });
      }

      setAsyncState(BUSY.saving);

      await api(props.apiBase, "/api/onboarding/bootstrap", {
        method: "POST",
        token: auth.accessToken,
        body: JSON.stringify({
          firstName: values.firstName,
          lastName: values.lastName,
          email: values.email,
          age: values.age,
          attribution,
        }),
      });

      void api(props.apiBase, "/api/onboarding/analytics", {
        method: "POST",
        body: JSON.stringify({ eventType: "ACCOUNT_COMPLETED" }),
      }).catch(() => undefined);

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
      if (mountedRef.current) {
        setAsyncState({ kind: "idle" });
        scrollSignupToTop();
      }
    }
    },
    (errors) => onInvalidScrollToError(errors as Record<string, unknown>)
  );

  const onLocation = locationForm.handleSubmit(
    async (values) => {
    if (busy) return;
    setError(null);
    setAsyncState(BUSY.saving);
    scrollSignupToTop();
    try {
      await saveStep("LOCATION", values);
      void api(props.apiBase, "/api/onboarding/analytics", {
        method: "POST",
        body: JSON.stringify({ eventType: "LOCATION_COMPLETED" }),
      }).catch(() => undefined);
      setAsyncState(BUSY.next);
      stepper.setComplete("location");
      await stepper.next();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Location save failed");
    } finally {
      if (mountedRef.current) {
        setAsyncState({ kind: "idle" });
        scrollSignupToTop();
      }
    }
    },
    (errors) => onInvalidScrollToError(errors as Record<string, unknown>)
  );

  const onBusiness = businessForm.handleSubmit(
    async (values) => {
    if (busy) return;
    setError(null);
    setAsyncState(BUSY.saving);
    scrollSignupToTop();
    try {
      await saveStep("BUSINESS", {
        ...values,
        socialLinks: socialLinks.filter((l) => l.url.trim()),
      });
      await saveStep("PAYMENT_PENDING", {});
      void api(props.apiBase, "/api/onboarding/analytics", {
        method: "POST",
        body: JSON.stringify({ eventType: "BUSINESS_COMPLETED" }),
      }).catch(() => undefined);
      setAsyncState(BUSY.next);
      stepper.setComplete("business");
      await stepper.next();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Business save failed");
    } finally {
      if (mountedRef.current) {
        setAsyncState({ kind: "idle" });
        scrollSignupToTop();
      }
    }
    },
    (errors) => onInvalidScrollToError(errors as Record<string, unknown>)
  );

  const applyPromoCode = async () => {
    const code = promoCode.trim();
    if (!code) {
      setPromoApplied(null);
      setPromoError("Enter a promo code.");
      return;
    }
    setPromoChecking(true);
    setPromoError(null);
    setPromoApplied(null);
    try {
      const res = (await api(props.apiBase, "/api/onboarding/billing-offer", {
        method: "POST",
        token: token || undefined,
        body: JSON.stringify({ code }),
      })) as Record<string, unknown>;
      if (res.applied === true) {
        setPromoApplied({
          offerCode: String(res.offerCode || code),
          priceKey: String(res.priceKey || ""),
          memberstackPriceId: String(res.memberstackPriceId || ""),
          label: typeof res.label === "string" ? res.label : null,
          description: typeof res.description === "string" ? res.description : null,
        });
      } else {
        setPromoError(
          typeof res.message === "string"
            ? res.message
            : "This promo code is invalid or has expired."
        );
      }
    } catch (e) {
      setPromoError(
        e instanceof Error && e.message
          ? e.message
          : "Could not validate promo code. Please try again."
      );
    } finally {
      setPromoChecking(false);
    }
  };

  const startCheckout = async () => {
    if (busy) return;
    setError(null);
    if (!communityOk) {
      setCommunityError(
        "Please confirm you're joining to connect and grow; not to cold-sell"
      );
      requestAnimationFrame(() => {
        const el = document.querySelector(".wlth-intention");
        if (el && el instanceof HTMLElement) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
      return;
    }
    setCommunityError(undefined);
    if (!termsOk) {
      setTermsError("Please agree to the Terms and Conditions before continuing.");
      requestAnimationFrame(() => {
        const el = document.querySelector(".wlth-terms");
        if (el && el instanceof HTMLElement) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
      return;
    }
    setTermsError(undefined);
    // Promo-code gate: a typed-but-invalid code must never silently fall back
    // to the default price.
    const typedCode = promoCode.trim();
    if (typedCode && !promoApplied) {
      setError(
        promoError ||
          "Enter a valid promo code or clear the promo field to continue with the standard price."
      );
      requestAnimationFrame(() => {
        const el = document.querySelector(".wlth-promo");
        if (el && el instanceof HTMLElement) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      });
      return;
    }
    // Outbound path: payment-verification only — never payment-confirmed
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
    const priceId = promoApplied?.memberstackPriceId || config?.membershipPriceId;
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
    {
      const mid = memberIdFromAccessToken(token);
      if (mid) {
        setSignupFlowMarker(mid);
        markAwaitingPostPaymentMatching(mid);
      }
    }
    await api(props.apiBase, "/api/onboarding/analytics", {
      method: "POST",
      body: JSON.stringify({ eventType: "CHECKOUT_STARTED" }),
    }).catch(() => undefined);

    void api(props.apiBase, "/api/onboarding/analytics", {
      method: "POST",
      body: JSON.stringify({ eventType: "CHECKOUT_ELIGIBLE" }),
    }).catch(() => undefined);

    try {
      const outcome = await runOutboundCheckout({
        purchase: () =>
          w.$memberstackDom!.purchasePlansWithCheckout!({
            priceId,
            successUrl: `${base}?payment=success`,
            cancelUrl: `${base}?payment=cancel`,
          }),
        confirmPaymentFromServer,
      });

      // Popup closed or same-tab return. If paid, URL/session flags trigger confirm
      // on the next path; if cancel, stay on Payment. Always try confirm when still
      // mounted so successful popup checkout advances to Matching.
      if (outcome === "navigating_or_closed" && mountedRef.current) {
        await new Promise((r) => setTimeout(r, 400));
        if (!mountedRef.current) return;
        const p = new URLSearchParams(window.location.search);
        if (p.get("payment") === "cancel") {
          clearCheckoutFlags();
          setAsyncState({ kind: "idle" });
          await stepper.goTo("payment");
          scrollSignupToTop();
          return;
        }
        // Success or ambiguous close after checkout — verify and advance if paid.
        await confirmPaymentFromServer(token);
      }
    } catch (e) {
      clearCheckoutFlags();
      const msg = e instanceof Error ? e.message : "";
      if (msg && !/cancel|closed|abort/i.test(msg)) {
        setError(msg);
      }
      if (mountedRef.current) {
        setAsyncState({ kind: "idle" });
      }
    }
  };

  const finish = async () => {
    setError(null);
    setAsyncState(BUSY.finish);
    scrollSignupToTop();
    try {
      if (token) {
        await api(props.apiBase, "/api/onboarding/complete", {
          method: "POST",
          token,
        });
        // Clear apply-flow markers only after payment verified path + final matching saved
        clearSignupFlowMarker();
        clearAwaitingPostPaymentMatching();
        markSignupSessionRefreshComplete({ accessToken: token });
      }
      setAsyncState(BUSY.redirect);
      window.location.assign(config?.homeUrl || "https://wlthwlks.com");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not complete");
      setAsyncState({ kind: "idle" });
    }
  };

  /* Availability toggle retained for possible future reactivation
  const toggleAvail = (code: string) => {
    const cur = locationForm.getValues("availability") || [];
    if (cur.includes(code)) {
      locationForm.setValue(
        "availability",
        cur.filter((c) => c !== code),
        { shouldValidate: true }
      );
    } else if (cur.length < 21) {
      locationForm.setValue("availability", [...cur, code], { shouldValidate: true });
    }
  };
  */

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
  const progressPct = Math.round(
    ((phaseIndex + (matchSub ? matchSub / 4 : 0.5)) / FLOW_DOTS.length) * 100
  );

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
            const isDone =
              idx < phaseIndex || (id === "matching" && matchSub > 0 && !isActive);
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
          <p className="wlth-subprogress">Matching · {matchSub} of 4</p>
        )}

        {error && (
          <div className="wlth-banner-error" role="alert">
            {error}
          </div>
        )}

        {stepper.is("account") && (
          <form className="wlth-step-panel" key="account" onSubmit={onAccount} noValidate>
            <h1>Let’s build your WLTH WLKS profile</h1>
            <p>A few details so we can welcome you properly.</p>
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
              <label htmlFor="age">Age</label>
              <select
                id="age"
                aria-invalid={!!accountForm.formState.errors.age}
                {...accountForm.register("age")}
              >
                <option value="">Select age range</option>
                {AGE_RANGES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <FieldError message={accountForm.formState.errors.age?.message} />
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
            <h2>Where would you like your community to begin?</h2>
            <p className="wlth-muted">
              We&apos;ll prioritise introductions near you; only cities currently open for
              matching are listed.
            </p>
            <LocationFields
              countries={refData.countries}
              cities={cities}
              countryRegister={
                locationForm.register("countryCode", {
                  onChange: () => {
                    locationForm.setValue("cityCode", "");
                  },
                }) as never
              }
              cityRegister={locationForm.register("cityCode") as never}
              countryError={locationForm.formState.errors.countryCode?.message}
              cityError={locationForm.formState.errors.cityCode?.message}
            />
            <div className="wlth-field">
              <label htmlFor="signup-postcode">Zip code</label>
              <input
                id="signup-postcode"
                autoComplete="postal-code"
                placeholder="Optional"
                aria-invalid={!!locationForm.formState.errors.postCode}
                {...locationForm.register("postCode")}
              />
              <FieldError message={locationForm.formState.errors.postCode?.message} />
            </div>
            <PhoneField
              phonePrefix={phonePrefix || ""}
              phoneRegister={locationForm.register("phone")}
              prefixError={locationForm.formState.errors.phonePrefix}
              phoneError={locationForm.formState.errors.phone}
              idPrefix="signup-ph"
            />
            <input type="hidden" {...locationForm.register("phonePrefix")} />
            <input type="hidden" {...locationForm.register("countryIso2")} />
            {/* Availability temporarily disabled. Keep component for possible future reactivation. */}
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
            <h2>Tell us what you’re building</h2>
            <p className="wlth-muted">
              A clear picture of your business helps us introduce you to the right peers.
            </p>
            <BusinessFields
              industries={refData.industries}
              stages={refData.businessStages}
              revenues={refData.revenueBrackets}
              primaryIndustry={primaryIndustry || ""}
              industryRegister={businessForm.register("primaryIndustry") as never}
              otherIndustryRegister={businessForm.register("otherIndustry") as never}
              stageRegister={businessForm.register("businessStage") as never}
              revenueRegister={businessForm.register("annualRevenue") as never}
              descriptionRegister={businessForm.register("businessDescription") as never}
              industryError={businessForm.formState.errors.primaryIndustry?.message}
              otherIndustryError={businessForm.formState.errors.otherIndustry?.message}
              stageError={businessForm.formState.errors.businessStage?.message}
              revenueError={businessForm.formState.errors.annualRevenue?.message}
              descriptionError={businessForm.formState.errors.businessDescription?.message}
            />

            <p className="wlth-section-title" style={{ marginTop: 20 }}>Social links (optional)</p>
            <p className="wlth-muted">Add your social profiles so members can connect.</p>
            {socialError && (
              <div className="wlth-banner-error" role="alert" style={{ marginBottom: 12 }}>
                {socialError}
              </div>
            )}
            {socialLinks.map((link, idx) => (
              <div key={link.platform} className="wlth-social-row">
                <span className="wlth-social-row__label">
                  {SOCIAL_PLATFORM_LABELS[link.platform]}
                </span>
                <input
                  className="wlth-social-row__input"
                  id={"signup-social-" + link.platform}
                  placeholder={link.platform + ".com/..."}
                  value={displayUrl(link.url)}
                  aria-invalid={!!socialLinksErrors[idx]}
                  onChange={(e) => updateSocialUrl(idx, e.target.value)}
                  onBlur={() => {
                    if (link.url.trim()) {
                      const result = normalizeSocialUrl(link.platform, link.url);
                      if (result.ok && result.url) {
                        const next = [...socialLinks];
                        next[idx] = { ...next[idx], url: displayUrl(result.url) };
                        setSocialLinks(next);
                        if (socialLinksErrors[idx]) {
                          const nextErrors = [...socialLinksErrors];
                          nextErrors[idx] = "";
                          setSocialLinksErrors(nextErrors);
                        }
                      } else if (!result.ok) {
                        const nextErrors = [...socialLinksErrors];
                        nextErrors[idx] = result.message;
                        setSocialLinksErrors(nextErrors);
                      }
                    }
                  }}
                />
                <button
                  type="button"
                  className="wlth-btn-remove"
                  onClick={() => removeSocialLink(idx)}
                  aria-label={"Remove " + SOCIAL_PLATFORM_LABELS[link.platform]}
                >
                  &times;
                </button>
                {socialLinksErrors[idx] ? (
                  <div className="wlth-error" style={{ width: "100%", marginTop: 4 }}>
                    {socialLinksErrors[idx]}
                  </div>
                ) : null}
              </div>
            ))}
            {!addingSocialPlatform && (
              <button
                type="button"
                className="wlth-btn-secondary"
                style={{ marginTop: 8 }}
                onClick={() => {
                  setSocialError("");
                  setAddingSocialPlatform(true);
                }}
              >
                + Add social profile
              </button>
            )}
            {addingSocialPlatform && (
              <div className="wlth-social-picker">
                <p className="wlth-muted">Select a platform:</p>
                <div className="wlth-social-picker__options">
                  {ADDABLE_SOCIAL_PLATFORMS.filter(
                    (p) => !socialLinks.some((l) => l.platform === p)
                  ).map((p) => (
                    <button
                      key={p}
                      type="button"
                      className="wlth-btn-secondary"
                      onClick={() => addSocialLink(p)}
                    >
                      {SOCIAL_PLATFORM_LABELS[p]}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="wlth-btn-secondary"
                  style={{ marginTop: 8 }}
                  onClick={() => setAddingSocialPlatform(false)}
                >
                  Cancel
                </button>
              </div>
            )}

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
              Complete your secure payment through Stripe and unlock a more intentional way
              to build valuable founder connections.
            </p>
            <div className="wlth-benefits">
              <p className="wlth-benefit">
                <strong>Curated introductions</strong>
                Shaped by your goals and business stage.
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

            <CommunityIntentionCard
              checked={communityOk}
              onChange={(v) => {
                setCommunityOk(v);
                if (v) setCommunityError(undefined);
              }}
              error={communityError}
              termsChecked={termsOk}
              onTermsChange={(v) => {
                setTermsOk(v);
                if (v) setTermsError(undefined);
              }}
              termsError={termsError}
            />

            <div className="wlth-promo">
              <label htmlFor="wlth-promo-code">
                Have a trial code? Paste it here — it changes your price
              </label>
              <div className="wlth-promo-row">
                <input
                  id="wlth-promo-code"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="e.g. FOUNDERS45"
                  value={promoCode}
                  onChange={(e) => {
                    const v = e.target.value;
                    setPromoCode(v);
                    setPromoError(null);
                    if (
                      promoApplied &&
                      promoApplied.offerCode.toUpperCase() !== v.trim().toUpperCase()
                    ) {
                      setPromoApplied(null);
                    }
                  }}
                />
                <button
                  type="button"
                  className="wlth-btn-secondary"
                  disabled={promoChecking}
                  onClick={() => void applyPromoCode()}
                >
                  {promoChecking ? "Checking…" : "Apply"}
                </button>
              </div>
              {promoApplied && (
                <p className="wlth-promo-ok">
                  <strong>{promoApplied.label || promoApplied.offerCode}</strong>
                  {promoApplied.description ? ` — ${promoApplied.description}` : ""}
                </p>
              )}
              {promoError && <p className="wlth-promo-err">{promoError}</p>}
            </div>

            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                disabled={busy || !communityOk || !termsOk}
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
            <h1>You’re in</h1>
            <p>Next: a few questions so we can improve your matching results.</p>
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                onClick={() => void stepper.goTo("goal")}
              >
                Continue to matching
              </button>
              <button type="button" className="wlth-btn-secondary" onClick={() => void finish()}>
                Go to home
              </button>
            </div>
          </div>
        )}

        {stepper.is("goal") && (
          <form
            className="wlth-step-panel"
            key="goal"
            onSubmit={goalForm.handleSubmit(
              async (v) => {
              if (busy) return;
              setError(null);
              setAsyncState(BUSY.saving);
              scrollSignupToTop();
              try {
                await saveStep("GOAL", v);
                setAsyncState(BUSY.next);
                await stepper.goTo("help");
              } catch (e) {
                setError(e instanceof Error ? e.message : "Save failed");
              } finally {
                if (mountedRef.current) {
                  setAsyncState({ kind: "idle" });
                  scrollSignupToTop();
                }
              }
              },
              (errors) => onInvalidScrollToError(errors as Record<string, unknown>)
            )}
            noValidate
          >
            <h2>Let’s shape the introductions that can move you forward</h2>
            <p className="wlth-muted">
              Your answers help us introduce you to the right people. They never change how
              matching algorithms run outside this profile.
            </p>
            <MatchingGoalField
              register={goalForm.register("ninetyDayGoal") as never}
              error={goalForm.formState.errors.ninetyDayGoal?.message as string}
            />
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
            onSubmit={helpForm.handleSubmit(
              async (v) => {
              if (busy) return;
              setError(null);
              setAsyncState(BUSY.saving);
              scrollSignupToTop();
              try {
                await saveStep("HELP_WANTED", v);
                setAsyncState(BUSY.next);
                await stepper.goTo("expertise");
              } catch (e) {
                setError(e instanceof Error ? e.message : "Save failed");
              } finally {
                if (mountedRef.current) {
                  setAsyncState({ kind: "idle" });
                  scrollSignupToTop();
                }
              }
              },
              (errors) => onInvalidScrollToError(errors as Record<string, unknown>)
            )}
          >
            <h2>Where would support help most?</h2>
            <MultiSelectDropdown
              label="Help wanted"
              helperText="Choose up to three areas."
              options={refData.helpWantedOptions}
              value={helpWanted}
              onChange={(next) => helpForm.setValue("helpWanted", next, { shouldValidate: true })}
              max={3}
              placeholder="Add an area of help"
            />
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
            onSubmit={expertiseForm.handleSubmit(
              async (v) => {
              if (busy) return;
              setError(null);
              setAsyncState(BUSY.saving);
              scrollSignupToTop();
              try {
                await saveStep("EXPERTISE", v);
                setAsyncState(BUSY.next);
                await stepper.goTo("connection");
              } catch (e) {
                setError(e instanceof Error ? e.message : "Save failed");
              } finally {
                if (mountedRef.current) {
                  setAsyncState({ kind: "idle" });
                  scrollSignupToTop();
                }
              }
              },
              (errors) => onInvalidScrollToError(errors as Record<string, unknown>)
            )}
          >
            <h2>What can you offer others?</h2>
            <MultiSelectDropdown
              label="Expertise offered"
              helperText="Choose up to five strengths."
              options={refData.expertiseOptions}
              value={expertiseOffered}
              onChange={(next) =>
                expertiseForm.setValue("expertiseOffered", next, { shouldValidate: true })
              }
              max={5}
              placeholder="Add an area of expertise"
            />
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
            onSubmit={connectionForm.handleSubmit(
              async (v) => {
              if (busy) return;
              setError(null);
              setAsyncState(BUSY.saving);
              scrollSignupToTop();
              try {
                await saveStep("CONNECTION", v);
                await finish();
              } catch (e) {
                setError(e instanceof Error ? e.message : "Save failed");
                setAsyncState({ kind: "idle" });
                scrollSignupToTop();
              }
              },
              (errors) => onInvalidScrollToError(errors as Record<string, unknown>)
            )}
            noValidate
          >
            <h2>Connection preference</h2>
            <ConnectionTypeField
              options={refData.connectionTypes}
              register={connectionForm.register("connectionType") as never}
              error={connectionForm.formState.errors.connectionType?.message as string}
            />
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

