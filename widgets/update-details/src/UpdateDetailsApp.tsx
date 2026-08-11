import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { widgetApi, type WidgetApiError } from "../../shared/api";
import {
  changeMemberstackPassword,
  logMemberstackDiagnostics,
  tryResolveSessionAccessToken,
} from "../../shared/memberstack-auth";
import { AnimatedLoader } from "../../shared/AnimatedLoader";
import { PageBlockingLoader } from "../../shared/PageBlockingLoader";
import {
  PhoneField,
  dialCodeForCountryCode,
  iso2ForCountryCode,
} from "../../shared/PhoneField";
import {
  AvailabilityFields,
  BusinessFields,
  ConnectionTypeField,
  FieldError,
  LocationFields,
  MatchingGoalField,
} from "../../shared/form-fields";
import { MultiSelectDropdown } from "../../shared/MultiSelectDropdown";
import {
  profileFormSchema,
  locationFormSchema,
  businessFormSchema,
  goalFormSchema,
  helpFormSchema,
  expertiseFormSchema,
  connectionFormSchema,
  type ProfileForm,
} from "../../shared/widget-schemas";
import {
  deriveLoginSessionId,
  markProfileRefreshComplete,
  decodeJwtPayload,
} from "../../shared/session-refresh-gate";
import { onInvalidScrollToError, scrollWidgetToTop, scrollToFirstFormError } from "../../shared/form-scroll";
import {
  clearAwaitingPostPaymentMatching,
  isAwaitingPostPaymentMatching,
  markAwaitingPostPaymentMatching,
} from "../../shared/signup-flow-marker";
import {
  normalizeBusinessWebsite,
  normalizeSocialUrl,
  findDuplicateSocialPlatforms,
  displayUrl,
  type SocialPlatform,
  type SocialLink,
  SOCIAL_PLATFORM_LABELS,
  ADDABLE_SOCIAL_PLATFORMS,
  isSocialPlatform,
} from "../../shared/profile-urls";

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(8, "New password must be at least 8 characters").max(128),
    confirmPassword: z.string().min(1, "Confirm your new password"),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

type PasswordForm = z.infer<typeof passwordSchema>;

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

/** Progressive steps — matching is split like signup (after payment). */
type RefreshStep =
  | "location"
  | "business"
  | "payment"
  | "goal"
  | "help"
  | "expertise"
  | "connection";

const MATCHING_REFRESH_STEPS: RefreshStep[] = ["goal", "help", "expertise", "connection"];

const CLIENT_IN_PROGRESS = new Set([
  "ACCOUNT_CREATED",
  "ACCOUNT",
  "LOCATION",
  "BUSINESS",
  "PAYMENT_PENDING",
  "PAYMENT_CONFIRMED",
  "GOAL",
  "HELP_WANTED",
  "EXPERTISE",
  "CONNECTION",
]);

/** Mirror server: blank/COMPLETE = established member (not mid-signup). */
function isClientInProgressOnboarding(status: string): boolean {
  const s = (status || "").trim().toUpperCase();
  if (!s || s === "COMPLETE") return false;
  return CLIENT_IN_PROGRESS.has(s);
}

/** resumeStage from API is already the *next* step to show. */
function resumeStageToRefreshStep(
  resumeStage: string,
  paymentConfirmed: boolean
): RefreshStep | "done" {
  const s = (resumeStage || "").toUpperCase();
  if (s === "COMPLETE") return "done";
  if (paymentConfirmed && (s === "PAYMENT_PENDING" || s === "PAYMENT_CONFIRMED")) {
    return "goal";
  }
  const map: Record<string, RefreshStep> = {
    LOCATION: "location",
    BUSINESS: "business",
    PAYMENT_PENDING: "payment",
    PAYMENT_CONFIRMED: "goal",
    GOAL: "goal",
    HELP_WANTED: "help",
    EXPERTISE: "expertise",
    CONNECTION: "connection",
    ACCOUNT: "location",
    ACCOUNT_CREATED: "location",
  };
  return map[s] || "location";
}

function topPhaseForRefreshStep(
  step: RefreshStep,
  includePayment: boolean
): "location" | "business" | "payment" | "matching" {
  if (step === "location") return "location";
  if (step === "business") return "business";
  if (step === "payment") return "payment";
  return includePayment ? "matching" : "matching";
}

async function api(base: string, path: string, opts: RequestInit & { token?: string } = {}) {
  return widgetApi(base, path, opts) as Promise<Record<string, unknown>>;
}

function memberIdFromToken(token: string): string {
  const p = decodeJwtPayload(token);
  if (p && typeof p.sub === "string") return p.sub.trim();
  if (p && typeof p.id === "string") return p.id.trim();
  return "";
}

export function UpdateDetailsApp(props: { apiBase: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [memberId, setMemberId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [pwSaving, setPwSaving] = useState(false);
  const [reactivating, setReactivating] = useState(false);
  const [refData, setRefData] = useState<RefData | null>(null);
  const [membershipPriceId, setMembershipPriceId] = useState("");
  const [billing, setBilling] = useState<{
    membership: string;
    payment: string;
    serviceAccessUntil: string;
    cancelAtPeriodEnd: boolean;
    cancellationEffectiveAt: string;
    stripeCustomerId?: string | null;
    hasPaymentMethod?: boolean;
    uiState?: string;
    stripeSubscriptionStatus?: string | null;
    stripeSubscriptionId?: string;
    currentPeriodEnd?: string | null;
    hasServiceAccess?: boolean;
    accessUntilLabel?: string;
  } | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  /** True when Airtable onboarding is not COMPLETE — use step API + resume. */
  const [onboardingIncomplete, setOnboardingIncomplete] = useState(false);
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);
  const [refreshStep, setRefreshStep] = useState<RefreshStep>("location");
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [previousCityUnavailable, setPreviousCityUnavailable] = useState(false);
  const [previousCityLabel, setPreviousCityLabel] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "dirty" | "saved">("idle");
  const [socialLinks, setSocialLinks] = useState<SocialLink[]>([]);
  const [socialLinksErrors, setSocialLinksErrors] = useState<Array<string>>([]);
  const [socialError, setSocialError] = useState("");
  const [webError, setWebError] = useState("");
  const [addingSocialPlatform, setAddingSocialPlatform] = useState(false);
  const mountedRef = useRef(true);

  const form = useForm<ProfileForm>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      phonePrefix: "",
      countryIso2: "",
      postCode: "",
      countryCode: "",
      cityCode: "",
      availability: [],
      professionalHeadline: "",
      profileBio: "",
      businessName: "",
      businessWebsite: "",
      primaryIndustry: "",
      otherIndustry: "",
      businessStage: "",
      annualRevenue: "",
      businessDescription: "",
      ninetyDayGoal: "",
      helpWanted: [],
      helpWantedContext: "",
      expertiseOffered: [],
      expertiseContext: "",
      connectionType: "",
      topicsToDiscuss: "",
      socialLinks: [],
    },
    mode: "onBlur",
  });

  const refreshLocation = useForm({
    resolver: zodResolver(locationFormSchema),
    defaultValues: {
      countryCode: "",
      cityCode: "",
      countryIso2: "",
      postCode: "",
      phone: "",
      phonePrefix: "",
      availability: [] as string[],
    },
  });
  const refreshBusiness = useForm({
    resolver: zodResolver(businessFormSchema),
    defaultValues: {
      primaryIndustry: "",
      otherIndustry: "",
      businessStage: "",
      annualRevenue: "",
      businessDescription: "Profile refresh — business context will be refined in full details.",
    },
  });
  // Matching refresh uses looser lengths for existing members
  const refreshGoal = useForm({
    resolver: zodResolver(goalFormSchema),
    defaultValues: { ninetyDayGoal: "" },
  });
  const refreshHelp = useForm({
    resolver: zodResolver(helpFormSchema),
    defaultValues: { helpWanted: [] as string[], helpWantedContext: "" },
  });
  const refreshExpertise = useForm({
    resolver: zodResolver(expertiseFormSchema),
    defaultValues: { expertiseOffered: [] as string[], expertiseContext: "" },
  });
  const refreshConnection = useForm({
    resolver: zodResolver(connectionFormSchema),
    defaultValues: { connectionType: "" },
  });

  const pwForm = useForm<PasswordForm>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const countryCode = form.watch("countryCode");
  const phonePrefix = form.watch("phonePrefix") || "";
  const primaryIndustry = form.watch("primaryIndustry") || "";
  const helpWanted = form.watch("helpWanted") || [];
  const expertiseOffered = form.watch("expertiseOffered") || [];
  const availability = form.watch("availability") || [];
  const isDirty = form.formState.isDirty;

  const rCountry = refreshLocation.watch("countryCode");
  const rPhonePrefix = refreshLocation.watch("phonePrefix") || "";
  const rAvailability = refreshLocation.watch("availability") || [];
  const rIndustry = refreshBusiness.watch("primaryIndustry") || "";
  const rHelp = refreshHelp.watch("helpWanted") || [];
  const rExpertise = refreshExpertise.watch("expertiseOffered") || [];

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fixed calling code from selected country on main profile form.
  useEffect(() => {
    if (!refData) return;
    if (!countryCode) {
      form.setValue("phonePrefix", "");
      form.setValue("countryIso2", "");
      return;
    }
    const dial = dialCodeForCountryCode(refData.countries, countryCode) || "";
    const iso2 = iso2ForCountryCode(refData.countries, countryCode) || "";
    form.setValue("phonePrefix", dial, { shouldValidate: true });
    form.setValue("countryIso2", iso2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countryCode, refData]);

  // Fixed calling code on progressive refresh location step.
  useEffect(() => {
    if (!refData) return;
    if (!rCountry) {
      refreshLocation.setValue("phonePrefix", "");
      refreshLocation.setValue("countryIso2", "");
      return;
    }
    const dial = dialCodeForCountryCode(refData.countries, rCountry) || "";
    const iso2 = iso2ForCountryCode(refData.countries, rCountry) || "";
    refreshLocation.setValue("phonePrefix", dial, { shouldValidate: true });
    refreshLocation.setValue("countryIso2", iso2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rCountry, refData]);

  useEffect(() => {
    if (isDirty) setSaveStatus("dirty");
  }, [isDirty]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (form.formState.isDirty && !saving) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [form.formState.isDirty, saving]);

  useEffect(() => {
    void (async () => {
      try {
        logMemberstackDiagnostics("update_details_mount");
        const t = await tryResolveSessionAccessToken();
        if (!t) {
          setError("Please log in with Memberstack to update your details.");
          setLoading(false);
          return;
        }
        setToken(t);
        const mid = memberIdFromToken(t);
        setMemberId(mid);
        const sid = deriveLoginSessionId({ memberId: mid, accessToken: t }) || `m:${mid}`;
        setSessionId(sid);

        const [cfg, ref, profileRes, bill, statusRes] = await Promise.all([
          api(props.apiBase, "/api/forms/config"),
          api(props.apiBase, "/api/reference-data/onboarding"),
          api(props.apiBase, "/api/member/profile", { token: t }),
          api(props.apiBase, "/api/member/billing-status", { token: t }),
          api(props.apiBase, "/api/onboarding/status", { token: t }).catch(() => null),
        ]);
        const rd = ref as unknown as RefData;
        setRefData(rd);
        setMembershipPriceId(
          String((cfg as { membershipPriceId?: string }).membershipPriceId || "")
        );
        const p = (profileRes.profile || {}) as Record<string, unknown>;
        const status = (statusRes || {}) as {
          exists?: boolean;
          onboardingStatus?: string | null;
          resumeStage?: string;
          paymentConfirmed?: boolean;
          onboardingIncomplete?: boolean;
        };
        const onboardingStatus = String(status.onboardingStatus || "").trim();
        const paidOk = Boolean(status.paymentConfirmed);
        setPaymentConfirmed(paidOk);

        /**
         * Progressive signup flow ONLY for mid new-widget onboarding.
         * Never use billing (cancelled / unpaid) to force matching for
         * legacy or already-complete members — they get the normal form
         * + Reactivate membership.
         */
        const midSignup =
          status.onboardingIncomplete === true ||
          isClientInProgressOnboarding(onboardingStatus);
        setOnboardingIncomplete(midSignup);

        const cityUnavailable = Boolean(p.previousCityUnavailable);
        setPreviousCityUnavailable(cityUnavailable);
        setPreviousCityLabel(String(p.previousCityLabel || p.city || ""));

        const countryCodeDefault = String(p.countryCode || "");
        const phonePrefixDefault = String(p.phonePrefix || "");
        const defaults: ProfileForm = {
          firstName: String(p.firstName || ""),
          lastName: String(p.lastName || ""),
          email: String(p.email || ""),
          phone: String(p.phone || ""),
          phonePrefix: phonePrefixDefault,
          countryIso2: "",
          postCode: String(p.postCode || ""),
          countryCode: countryCodeDefault,
          cityCode: cityUnavailable ? "" : String(p.cityCode || ""),
          availability: Array.isArray(p.availability) ? (p.availability as string[]) : [],
          professionalHeadline: String(p.professionalHeadline || ""),
          profileBio: String(p.profileBio || ""),
          businessName: String(p.businessName || ""),
          businessWebsite: String(p.businessWebsite || ""),
          primaryIndustry: String(p.primaryIndustry || ""),
          otherIndustry: String(p.otherIndustry || ""),
          businessStage: String(p.businessStage || ""),
          annualRevenue: String(p.annualRevenue || ""),
          businessDescription: String(p.businessDescription || ""),
          ninetyDayGoal: String(p.ninetyDayGoal || ""),
          helpWanted: Array.isArray(p.helpWanted) ? (p.helpWanted as string[]) : [],
          helpWantedContext: String(p.helpWantedContext || ""),
          expertiseOffered: Array.isArray(p.expertiseOffered)
            ? (p.expertiseOffered as string[])
            : [],
          expertiseContext: String(p.expertiseContext || ""),
          connectionType: String(p.connectionType || ""),
          topicsToDiscuss: String(p.topicsToDiscuss || ""),
          socialLinks:
            Array.isArray(p.socialLinks) ? (p.socialLinks as SocialLink[]) : [],
        };
        form.reset(defaults);

        if (Array.isArray(p.socialLinks) && p.socialLinks.length > 0) {
          setSocialLinks(p.socialLinks as SocialLink[]);
          setSocialLinksErrors(
            (p.socialLinks as SocialLink[]).map(() => "")
          );
        }

        refreshLocation.reset({
          countryCode: defaults.countryCode || "",
          cityCode: defaults.cityCode || "",
          countryIso2: "",
          postCode: defaults.postCode || "",
          phone: defaults.phone || "",
          phonePrefix: defaults.phonePrefix || "",
          availability: defaults.availability || [],
        });
        refreshBusiness.reset({
          primaryIndustry: defaults.primaryIndustry || "",
          otherIndustry: defaults.otherIndustry || "",
          businessStage: defaults.businessStage || "",
          annualRevenue: defaults.annualRevenue || "",
          businessDescription:
            defaults.businessDescription ||
            "I’m refreshing my WLTH WLKS profile so introductions stay aligned with where my business is today.",
        });
        refreshGoal.reset({ ninetyDayGoal: defaults.ninetyDayGoal || "" });
        refreshHelp.reset({
          helpWanted: defaults.helpWanted || [],
          helpWantedContext: defaults.helpWantedContext || "",
        });
        refreshExpertise.reset({
          expertiseOffered: defaults.expertiseOffered || [],
          expertiseContext: defaults.expertiseContext || "",
        });
        refreshConnection.reset({ connectionType: defaults.connectionType || "" });

        // Mid new-widget signup only — cancelled legacy members skip straight to full form.
        if (midSignup) {
          setNeedsRefresh(true);
          const resume = resumeStageToRefreshStep(
            String(status.resumeStage || "LOCATION"),
            paidOk
          );
          setRefreshStep(resume === "done" ? "location" : resume);
        } else {
          setNeedsRefresh(false);
          setRefreshStep("location");
          // Established members: remember session so we don't re-prompt soft refresh
          if (mid && sid) {
            markProfileRefreshComplete({ memberId: mid, sessionId: sid });
          }
        }

        setBilling(
          (bill.billing || null) as {
            membership: string;
            payment: string;
            serviceAccessUntil: string;
            cancelAtPeriodEnd: boolean;
            cancellationEffectiveAt: string;
            stripeCustomerId?: string | null;
            hasPaymentMethod?: boolean;
          } | null
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load profile");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.apiBase]);

  const cities = useMemo(
    () => (refData?.cities || []).filter((c) => c.countryCode === countryCode),
    [refData, countryCode]
  );
  const refreshCities = useMemo(
    () => (refData?.cities || []).filter((c) => c.countryCode === rCountry),
    [refData, rCountry]
  );

  const needsReactivation = useMemo(() => {
    if (!billing) return false;
    // Use server uiState when available (derived from live Stripe + Airtable)
    if (billing.uiState) {
      if (billing.uiState === "active") return false;
      if (billing.uiState === "cancellation_scheduled") return true;
      if (billing.uiState === "payment_problem") return true;
      if (billing.uiState === "expired") return true;
      if (billing.uiState === "incomplete_onboarding") return true;
      return true;
    }
    // Fallback — legacy Airtable-based heuristic
    const mem = (billing.membership || "").toLowerCase();
    const pay = (billing.payment || "").toLowerCase();
    if (pay === "paid" && mem === "active" && !billing.cancelAtPeriodEnd) return false;
    if (mem === "pending payment" || pay === "unpaid" || pay === "failed") return true;
    if (billing.cancelAtPeriodEnd) return true;
    if (mem && mem !== "active") return true;
    if (pay && pay !== "paid") return true;
    return false;
  }, [billing]);

  /** Payment inside progressive flow only for mid-signup who are not yet Paid+Active. */
  const refreshNeedsPaymentStep = useMemo(() => {
    if (!onboardingIncomplete) return false;
    if (paymentConfirmed) return false;
    return true;
  }, [onboardingIncomplete, paymentConfirmed]);

  /** Top-level dots: Location → Business → [Payment] → Matching */
  const refreshTopPhases = useMemo(() => {
    const phases: Array<"location" | "business" | "payment" | "matching"> = [
      "location",
      "business",
    ];
    if (refreshNeedsPaymentStep) phases.push("payment");
    phases.push("matching");
    return phases;
  }, [refreshNeedsPaymentStep]);

  const scrollDetailsToTop = () => {
    scrollWidgetToTop("wlth-update-details-root");
  };

  const addSocialLink = (platform: SocialPlatform) => {
    if (socialLinks.some((l) => l.platform === platform)) {
      setSocialError("This platform is already added.");
      return;
    }
    setSocialLinks([...socialLinks, { platform, url: "" }]);
    setSocialLinksErrors([...socialLinksErrors, ""]);
    setSocialError("");
    setAddingSocialPlatform(false);
    setSaveStatus("dirty");
  };

  const updateSocialUrl = (index: number, url: string) => {
    const next = [...socialLinks];
    next[index] = { ...next[index], url };
    setSocialLinks(next);
    // Clear per-link error on edit
    if (socialLinksErrors[index]) {
      const nextErrors = [...socialLinksErrors];
      nextErrors[index] = "";
      setSocialLinksErrors(nextErrors);
    }
    setSaveStatus("dirty");
  };

  const removeSocialLink = (index: number) => {
    setSocialLinks(socialLinks.filter((_, i) => i !== index));
    setSocialLinksErrors(socialLinksErrors.filter((_, i) => i !== index));
    setSocialError("");
    setSaveStatus("dirty");
  };

  const validateFormSocialLinksAndWebsite = (): { ok: boolean; errorEls: Element[] } => {
    const errorEls: Element[] = [];
    let ok = true;

    // Validate business website
    const webVal = String(form.getValues("businessWebsite") || "").trim();
    if (webVal) {
      const result = normalizeBusinessWebsite(webVal);
      if (!result.ok) {
        setWebError(result.message);
        ok = false;
        const input = document.getElementById("upd-bizweb");
        if (input) { input.setAttribute("aria-invalid", "true"); errorEls.push(input); }
      } else {
        setWebError("");
        const input = document.getElementById("upd-bizweb");
        if (input) input.removeAttribute("aria-invalid");
      }
    } else {
      setWebError("");
      const input = document.getElementById("upd-bizweb");
      if (input) input.removeAttribute("aria-invalid");
    }

    // Validate social links
    const nextErrors = socialLinks.map(() => "");
    let hasSocialError = false;

    for (let i = 0; i < socialLinks.length; i++) {
      const link = socialLinks[i];
      if (!link.url.trim()) continue;
      const result = normalizeSocialUrl(link.platform, link.url);
      if (!result.ok) {
        nextErrors[i] = result.message;
        hasSocialError = true;
        ok = false;
      }
    }

    setSocialLinksErrors(nextErrors);
    if (hasSocialError) {
      setSocialError("Some links need attention. Check the errors below.");
    } else {
      setSocialError("");
    }

    // Collect error elements for scroll
    if (!ok) {
      requestAnimationFrame(() => {
        const els = document.querySelectorAll("#wlth-update-profile-form .wlth-social-row__input[aria-invalid='true'], #wlth-update-profile-form #upd-bizweb[aria-invalid='true']");
        els.forEach(el => errorEls.push(el));
        scrollToFirstFormError(
          document.getElementById("wlth-update-profile-form") as HTMLFormElement | null,
          [],
          errorEls,
        );
      });
    }

    return { ok, errorEls };
  };

  const patchProfile = async (body: Record<string, unknown>) => {
    if (!token) throw new Error("Not signed in");
    return api(props.apiBase, "/api/member/profile", {
      method: "PATCH",
      token,
      body: JSON.stringify(body),
    });
  };

  /** Parse Zod fieldErrors or structured fields from server response into RHF + social errors. */
  const applyServerFieldErrors = (e: unknown) => {
    const err = e as WidgetApiError;

    // 1) Structured fields map (new format from profile route / reactivate)
    let fieldMap: Record<string, string> | undefined;
    if (err.fields && typeof err.fields === "object") {
      fieldMap = err.fields;
    } else if (err.body?.fields && typeof err.body.fields === "object") {
      fieldMap = err.body.fields as Record<string, string>;
    }

    // 2) Legacy details.fieldErrors (Zod flatten)
    let legacyFieldErrors: Record<string, string[]> | undefined;
    if (err.details && typeof err.details === "object") {
      const d = err.details as Record<string, unknown>;
      if (d.fieldErrors && typeof d.fieldErrors === "object") {
        legacyFieldErrors = d.fieldErrors as Record<string, string[]>;
      }
    }

    let found = false;

    // Process structured fields map first
    if (fieldMap) {
      for (const [field, msg] of Object.entries(fieldMap)) {
        if (!msg) continue;
        if (field === "socialLinks") {
          setSocialError(String(msg));
          found = true;
          continue;
        }
        form.setError(field as keyof ProfileForm, { message: String(msg) }, { shouldFocus: true });
        found = true;
      }
    }

    // Process legacy Zod field errors
    if (!found && legacyFieldErrors) {
      for (const [field, messages] of Object.entries(legacyFieldErrors)) {
        const msg = Array.isArray(messages) ? messages[0] : messages;
        if (!msg) continue;
        if (field === "socialLinks") {
          setSocialError(String(msg));
          found = true;
          continue;
        }
        form.setError(field as keyof ProfileForm, { message: String(msg) }, { shouldFocus: true });
        found = true;
      }
    }

    if (found) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() =>
          scrollToFirstFormError(
            document.getElementById("wlth-update-profile-form") as HTMLFormElement | null,
            Object.keys(fieldMap || legacyFieldErrors || {}),
            document.querySelectorAll("#wlth-update-profile-form .wlth-error") as unknown as Element[]
          )
        );
      });
    }
    return found;
  };

  /** Save progress like signup — updates Onboarding status + Last completed signup step. */
  const saveOnboardingStep = async (stage: string, data: unknown) => {
    if (!token) throw new Error("Not signed in");
    await api(props.apiBase, "/api/onboarding/step", {
      method: "PATCH",
      token,
      body: JSON.stringify({ stage, data }),
    });
  };

  const syncFormFromPartial = (payload: Record<string, unknown>) => {
    form.reset({
      ...form.getValues(),
      ...payload,
      countryCode: String(payload.countryCode ?? form.getValues("countryCode") ?? ""),
      cityCode: String(payload.cityCode ?? form.getValues("cityCode") ?? ""),
      availability: (payload.availability as string[]) || form.getValues("availability"),
      primaryIndustry: String(
        payload.primaryIndustry ?? form.getValues("primaryIndustry") ?? ""
      ),
      otherIndustry: String(payload.otherIndustry ?? form.getValues("otherIndustry") ?? ""),
      businessStage: String(payload.businessStage ?? form.getValues("businessStage") ?? ""),
      annualRevenue: String(payload.annualRevenue ?? form.getValues("annualRevenue") ?? ""),
      businessDescription: String(
        payload.businessDescription ?? form.getValues("businessDescription") ?? ""
      ),
      ninetyDayGoal: String(payload.ninetyDayGoal ?? form.getValues("ninetyDayGoal") ?? ""),
      helpWanted: (payload.helpWanted as string[]) || form.getValues("helpWanted") || [],
      helpWantedContext: String(
        payload.helpWantedContext ?? form.getValues("helpWantedContext") ?? ""
      ),
      expertiseOffered:
        (payload.expertiseOffered as string[]) || form.getValues("expertiseOffered") || [],
      expertiseContext: String(
        payload.expertiseContext ?? form.getValues("expertiseContext") ?? ""
      ),
      connectionType: String(payload.connectionType ?? form.getValues("connectionType") ?? ""),
    });
  };

  const finishRefreshSession = (message?: string) => {
    if (memberId && sessionId) {
      markProfileRefreshComplete({ memberId, sessionId });
    }
    setOnboardingIncomplete(false);
    setNeedsRefresh(false);
    setOk(
      message ||
        "Your profile is refreshed — your future introductions can now reflect where you are and what you need today."
    );
    setSaveStatus("saved");
    scrollDetailsToTop();
  };

  const goAfterPaymentToMatching = () => {
    setPaymentConfirmed(true);
    setRefreshStep("goal");
    scrollDetailsToTop();
  };

  const startRefreshCheckout = async () => {
    if (!token || refreshBusy) return;
    setError(null);
    setRefreshBusy(true);
    scrollDetailsToTop();
    try {
      if (onboardingIncomplete) {
        await saveOnboardingStep("PAYMENT_PENDING", {});
      }
      const w = window as unknown as {
        $memberstackDom?: {
          purchasePlansWithCheckout?: (p: {
            priceId: string;
            successUrl: string;
            cancelUrl: string;
          }) => Promise<unknown>;
        };
      };
      if (!membershipPriceId || !w.$memberstackDom?.purchasePlansWithCheckout) {
        setError("Secure checkout is not available on this page right now.");
        return;
      }
      const base = window.location.origin + window.location.pathname;
      if (memberId) markAwaitingPostPaymentMatching(memberId);
      await w.$memberstackDom.purchasePlansWithCheckout({
        priceId: membershipPriceId,
        successUrl: `${base}?refresh_paid=1`,
        cancelUrl: `${base}?refresh_paid=0`,
      });
      // Popup closed without navigation — try confirm, then matching if paid
      await api(props.apiBase, "/api/onboarding/confirm-checkout", {
        method: "POST",
        token,
        body: JSON.stringify({}),
      }).catch(() => undefined);
      const st = await api(props.apiBase, "/api/onboarding/status", { token }).catch(
        () => null
      );
      const bill = await api(props.apiBase, "/api/member/billing-status", { token });
      setBilling((bill.billing || null) as typeof billing);
      if (st && st.paymentConfirmed) {
        goAfterPaymentToMatching();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg && !/cancel|closed|abort/i.test(msg)) setError(msg);
    } finally {
      if (mountedRef.current) setRefreshBusy(false);
    }
  };

  const reactivateFromRefreshPayment = async () => {
    if (!token || refreshBusy) return;
    setError(null);
    setRefreshBusy(true);
    scrollDetailsToTop();
    try {
      const res = (await api(props.apiBase, "/api/member/reactivate", {
        method: "POST",
        token,
        body: JSON.stringify({}),
      })) as Record<string, unknown>;
      if (!res.success) {
        const status = String(res.status || "");
        if (
          status === "no_payment_method" ||
          status === "no_stripe_customer" ||
          Boolean(res.requiresPaymentMethod)
        ) {
          await startRefreshCheckout();
          return;
        }
        setError(String(res.reason || res.message || "Could not activate membership"));
        return;
      }
      await api(props.apiBase, "/api/onboarding/confirm-checkout", {
        method: "POST",
        token,
        body: JSON.stringify({}),
      }).catch(() => undefined);
      const bill = await api(props.apiBase, "/api/member/billing-status", { token });
      setBilling((bill.billing || null) as typeof billing);
      goAfterPaymentToMatching();
    } catch (e) {
      const werr = e as WidgetApiError;
      if (werr.apiStatus === "no_payment_method" || werr.requiresPaymentMethod) {
        await startRefreshCheckout();
        return;
      }
      setError(e instanceof Error ? e.message : "Could not activate membership");
    } finally {
      if (mountedRef.current) setRefreshBusy(false);
    }
  };

  const onRefreshLocation = refreshLocation.handleSubmit(
    async (values) => {
      setError(null);
      setRefreshBusy(true);
      scrollDetailsToTop();
      try {
        if (onboardingIncomplete) {
          await saveOnboardingStep("LOCATION", values);
        } else {
          await patchProfile({
            countryCode: values.countryCode,
            cityCode: values.cityCode,
            availability: values.availability,
            postCode: values.postCode ?? "",
            phone: values.phone,
            phonePrefix: values.phonePrefix,
            countryIso2: values.countryIso2 || undefined,
          });
        }
        form.setValue("countryCode", values.countryCode);
        form.setValue("cityCode", values.cityCode);
        form.setValue("availability", values.availability);
        form.setValue("postCode", values.postCode ?? "");
        form.setValue("phone", values.phone);
        form.setValue("phonePrefix", values.phonePrefix);
        form.setValue("countryIso2", values.countryIso2 ?? "");
        setPreviousCityUnavailable(false);
        setRefreshStep("business");
        scrollDetailsToTop();
      } catch (e) {
        if (!applyServerFieldErrors(e)) {
          setError(e instanceof Error ? e.message : "Could not save location");
        }
      } finally {
        if (mountedRef.current) setRefreshBusy(false);
      }
    },
    (errors) => onInvalidScrollToError(errors as Record<string, unknown>)
  );

  const onRefreshBusiness = refreshBusiness.handleSubmit(
    async (values) => {
      setError(null);
      setRefreshBusy(true);
      scrollDetailsToTop();
      try {
        if (onboardingIncomplete) {
          await saveOnboardingStep("BUSINESS", values);
          await saveOnboardingStep("PAYMENT_PENDING", {});
        } else {
          await patchProfile({
            primaryIndustry: values.primaryIndustry,
            otherIndustry: values.otherIndustry,
            businessStage: values.businessStage,
            annualRevenue: values.annualRevenue,
            businessDescription: values.businessDescription,
          });
        }
        form.setValue("primaryIndustry", values.primaryIndustry);
        form.setValue("otherIndustry", values.otherIndustry || "");
        form.setValue("businessStage", values.businessStage);
        form.setValue("annualRevenue", values.annualRevenue);
        form.setValue("businessDescription", values.businessDescription);
        // Payment before matching when still unpaid
        if (refreshNeedsPaymentStep && !paymentConfirmed) {
          setRefreshStep("payment");
        } else {
          setRefreshStep("goal");
        }
        scrollDetailsToTop();
      } catch (e) {
        if (!applyServerFieldErrors(e)) {
          setError(e instanceof Error ? e.message : "Could not save business details");
        }
      } finally {
        if (mountedRef.current) setRefreshBusy(false);
      }
    },
    (errors) => onInvalidScrollToError(errors as Record<string, unknown>)
  );

  const onRefreshGoal = refreshGoal.handleSubmit(
    async (values) => {
      setError(null);
      setRefreshBusy(true);
      scrollDetailsToTop();
      try {
        if (onboardingIncomplete) {
          await saveOnboardingStep("GOAL", values);
        } else {
          await patchProfile({ ninetyDayGoal: values.ninetyDayGoal });
        }
        form.setValue("ninetyDayGoal", values.ninetyDayGoal);
        setRefreshStep("help");
        scrollDetailsToTop();
      } catch (e) {
        if (!applyServerFieldErrors(e)) {
          setError(e instanceof Error ? e.message : "Could not save goal");
        }
      } finally {
        if (mountedRef.current) setRefreshBusy(false);
      }
    },
    (errors) => onInvalidScrollToError(errors as Record<string, unknown>)
  );

  const onRefreshHelp = refreshHelp.handleSubmit(
    async (values) => {
      setError(null);
      setRefreshBusy(true);
      scrollDetailsToTop();
      try {
        if (onboardingIncomplete) {
          await saveOnboardingStep("HELP_WANTED", values);
        } else {
          await patchProfile({
            helpWanted: values.helpWanted || [],
            helpWantedContext: values.helpWantedContext || "",
          });
        }
        form.setValue("helpWanted", values.helpWanted || []);
        form.setValue("helpWantedContext", values.helpWantedContext || "");
        setRefreshStep("expertise");
        scrollDetailsToTop();
      } catch (e) {
        if (!applyServerFieldErrors(e)) {
          setError(e instanceof Error ? e.message : "Could not save help preferences");
        }
      } finally {
        if (mountedRef.current) setRefreshBusy(false);
      }
    },
    (errors) => onInvalidScrollToError(errors as Record<string, unknown>)
  );

  const onRefreshExpertise = refreshExpertise.handleSubmit(
    async (values) => {
      setError(null);
      setRefreshBusy(true);
      scrollDetailsToTop();
      try {
        if (onboardingIncomplete) {
          await saveOnboardingStep("EXPERTISE", values);
        } else {
          await patchProfile({
            expertiseOffered: values.expertiseOffered || [],
            expertiseContext: values.expertiseContext || "",
          });
        }
        form.setValue("expertiseOffered", values.expertiseOffered || []);
        form.setValue("expertiseContext", values.expertiseContext || "");
        setRefreshStep("connection");
        scrollDetailsToTop();
      } catch (e) {
        if (!applyServerFieldErrors(e)) {
          setError(e instanceof Error ? e.message : "Could not save expertise");
        }
      } finally {
        if (mountedRef.current) setRefreshBusy(false);
      }
    },
    (errors) => onInvalidScrollToError(errors as Record<string, unknown>)
  );

  const onRefreshConnection = refreshConnection.handleSubmit(
    async (values) => {
      setError(null);
      setRefreshBusy(true);
      scrollDetailsToTop();
      try {
        if (onboardingIncomplete) {
          await saveOnboardingStep("CONNECTION", values);
          // Mark COMPLETE + Last completed signup step (same as signup finish)
          await api(props.apiBase, "/api/onboarding/complete", {
            method: "POST",
            token: token!,
          });
          setOnboardingIncomplete(false);
        } else {
          await patchProfile({ connectionType: values.connectionType });
        }
        form.setValue("connectionType", values.connectionType);
        syncFormFromPartial({
          ninetyDayGoal: refreshGoal.getValues("ninetyDayGoal"),
          helpWanted: refreshHelp.getValues("helpWanted") || [],
          helpWantedContext: refreshHelp.getValues("helpWantedContext") || "",
          expertiseOffered: refreshExpertise.getValues("expertiseOffered") || [],
          expertiseContext: refreshExpertise.getValues("expertiseContext") || "",
          connectionType: values.connectionType,
        });
        finishRefreshSession(
          "You’re all set — your profile is complete and ready for stronger introductions."
        );
      } catch (e) {
        if (!applyServerFieldErrors(e)) {
          setError(e instanceof Error ? e.message : "Could not finish profile");
        }
      } finally {
        if (mountedRef.current) setRefreshBusy(false);
      }
    },
    (errors) => onInvalidScrollToError(errors as Record<string, unknown>)
  );

  const onSave = form.handleSubmit(
    async (values) => {
    if (!token || saving) return;
    const preCheck = validateFormSocialLinksAndWebsite();
    if (!preCheck.ok) return;
    setSaving(true);
    scrollDetailsToTop();
    setError(null);
    setOk(null);
    setWebError("");
    try {
      await api(props.apiBase, "/api/member/email", {
        method: "POST",
        token,
        body: JSON.stringify({ email: values.email }),
      });
      const res = await api(props.apiBase, "/api/member/profile", {
        method: "PATCH",
        token,
        body: JSON.stringify({
          firstName: values.firstName,
          lastName: values.lastName,
          phone: values.phone ?? "",
          phonePrefix: values.phonePrefix ?? "",
          countryIso2: values.countryIso2 || undefined,
          postCode: values.postCode ?? "",
          countryCode: values.countryCode || undefined,
          cityCode: values.cityCode || undefined,
          availability: values.availability ?? [],
          primaryIndustry: values.primaryIndustry || undefined,
          otherIndustry: values.otherIndustry ?? "",
          businessStage: values.businessStage || undefined,
          annualRevenue: values.annualRevenue || undefined,
          businessDescription: values.businessDescription || undefined,
          businessName: values.businessName ?? "",
          businessWebsite: values.businessWebsite ?? "",
          professionalHeadline: values.professionalHeadline ?? "",
          profileBio: values.profileBio ?? "",
          ninetyDayGoal: values.ninetyDayGoal || undefined,
          // Explicit arrays/strings so empty clears Airtable
          helpWanted: values.helpWanted ?? [],
          helpWantedContext: values.helpWantedContext ?? "",
          expertiseOffered: values.expertiseOffered ?? [],
          expertiseContext: values.expertiseContext ?? "",
          connectionType: values.connectionType || undefined,
          topicsToDiscuss: values.topicsToDiscuss ?? "",
          socialLinks: socialLinks.length > 0
            ? socialLinks.map((l) => ({ platform: l.platform, url: l.url }))
            : [],
        }),
      });
      const p = (res.profile || {}) as Record<string, unknown>;
      form.reset({
        firstName: String(p.firstName ?? values.firstName),
        lastName: String(p.lastName ?? values.lastName),
        email: String(p.email ?? values.email),
        phone: String(p.phone ?? values.phone ?? ""),
        phonePrefix: String(p.phonePrefix ?? values.phonePrefix ?? ""),
        countryIso2: String(p.countryIso2 ?? values.countryIso2 ?? ""),
        postCode: String(p.postCode ?? values.postCode ?? ""),
        countryCode: String(p.countryCode ?? values.countryCode ?? ""),
        cityCode: String(p.cityCode ?? values.cityCode ?? ""),
        availability: Array.isArray(p.availability)
          ? (p.availability as string[])
          : values.availability || [],
        primaryIndustry: String(p.primaryIndustry ?? values.primaryIndustry ?? ""),
        otherIndustry: String(p.otherIndustry ?? values.otherIndustry ?? ""),
        businessStage: String(p.businessStage ?? values.businessStage ?? ""),
        annualRevenue: String(p.annualRevenue ?? values.annualRevenue ?? ""),
        businessDescription: String(
          p.businessDescription ?? values.businessDescription ?? ""
        ),
        businessName: String(p.businessName ?? values.businessName ?? ""),
        businessWebsite: String(p.businessWebsite ?? values.businessWebsite ?? ""),
        professionalHeadline: String(p.professionalHeadline ?? values.professionalHeadline ?? ""),
        profileBio: String(p.profileBio ?? values.profileBio ?? ""),
        ninetyDayGoal: String(p.ninetyDayGoal ?? values.ninetyDayGoal ?? ""),
        helpWanted: Array.isArray(p.helpWanted)
          ? (p.helpWanted as string[])
          : values.helpWanted || [],
        helpWantedContext: String(p.helpWantedContext ?? values.helpWantedContext ?? ""),
        expertiseOffered: Array.isArray(p.expertiseOffered)
          ? (p.expertiseOffered as string[])
          : values.expertiseOffered || [],
        expertiseContext: String(p.expertiseContext ?? values.expertiseContext ?? ""),
        connectionType: String(p.connectionType ?? values.connectionType ?? ""),
        topicsToDiscuss: String(p.topicsToDiscuss ?? values.topicsToDiscuss ?? ""),
        socialLinks:
          Array.isArray(p.socialLinks)
            ? (p.socialLinks as SocialLink[])
            : socialLinks,
      });
      if (!Array.isArray(p.socialLinks) || (p.socialLinks as SocialLink[]).length === 0) {
        setSocialLinks(socialLinks);
      }
      setPreviousCityUnavailable(Boolean(p.previousCityUnavailable));
      setOk("Your profile is up to date and ready for stronger introductions.");
      setSaveStatus("saved");
    } catch (e) {
      if (!applyServerFieldErrors(e)) {
        setError(e instanceof Error ? e.message : "Save failed");
      }
    } finally {
      if (mountedRef.current) setSaving(false);
    }
    },
    (errors) => onInvalidScrollToError(errors as Record<string, unknown>)
  );

  const onPassword = pwForm.handleSubmit(async (values) => {
    setPwSaving(true);
    setError(null);
    setOk(null);
    try {
      await changeMemberstackPassword({
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
        email: form.getValues("email"),
      });
      pwForm.reset();
      setOk("Password updated successfully.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Password change failed");
    } finally {
      setPwSaving(false);
    }
  });

  const openPortal = async () => {
    const w = window as unknown as {
      $memberstackDom?: { launchStripeCustomerPortal?: () => Promise<unknown> };
    };
    if (!w.$memberstackDom?.launchStripeCustomerPortal) {
      setError("Stripe Customer Portal is not available on this page.");
      return;
    }
    await w.$memberstackDom.launchStripeCustomerPortal({
      returnUrl: window.location.href,
    });
  };

  const reactivateMembership = async () => {
    if (!token) return;
    setReactivating(true);
    scrollDetailsToTop();
    setError(null);
    setOk(null);
    try {
      const res = (await api(props.apiBase, "/api/member/reactivate", {
        method: "POST",
        token,
        body: JSON.stringify({}),
      })) as Record<string, unknown>;
      if (!res.success) {
        const status = String(res.status || "");
        if (
          status === "no_payment_method" ||
          status === "payment_problem" ||
          Boolean(res.requiresPaymentMethod)
        ) {
          setError(
            String(res.reason || res.message || "Add a payment method to continue your membership.")
          );
          return;
        }
        if (status === "no_stripe_customer") {
          setError(
            String(res.reason || res.message || "No Stripe customer — complete checkout first.")
          );
          return;
        }
        setError(String(res.reason || res.message || "Could not reactivate membership"));
        return;
      }
      const status = String(res.status || "");
      if (status === "cancellation_reversed") {
        const next = typeof res.nextRenewalDate === "string" ? res.nextRenewalDate : "";
        setOk(
          String(
            res.reason ||
              res.message ||
              "Your membership is active again. You will not be charged today." +
                (next ? ` Your next renewal is ${next}.` : "")
          )
        );
      } else if (status === "already_active") {
        setOk(String(res.reason || res.message || "Your membership is already active."));
      } else {
        setOk(String(res.reason || res.message || "Membership reactivated with your card on file."));
      }
      const bill = await api(props.apiBase, "/api/member/billing-status", { token });
      setBilling((bill.billing || null) as typeof billing);
    } catch (e) {
      const werr = e as WidgetApiError;
      // API returns 402 with message now — surface it
      const reason = werr.reason || werr.message || "";
      if (
        reason &&
        !/cancel|closed|abort/i.test(reason)
      ) {
        if (werr.apiStatus === "no_payment_method" || werr.requiresPaymentMethod) {
          setError(reason);
        } else {
          setError(reason);
        }
      } else if (!reason) {
        setError("Could not reactivate membership. Please try again.");
      }
    } finally {
      if (mountedRef.current) setReactivating(false);
    }
  };

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (!token) return;

    if (p.get("reactivated") === "1") {
      void (async () => {
        setOk("Welcome back — confirming your membership…");
        await api(props.apiBase, "/api/onboarding/confirm-checkout", {
          method: "POST",
          token,
          body: JSON.stringify({}),
        }).catch(() => undefined);
        const bill = await api(props.apiBase, "/api/member/billing-status", { token });
        setBilling((bill.billing || null) as typeof billing);
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete("reactivated");
          window.history.replaceState({}, "", url.pathname + url.search);
        } catch {
          /* ignore */
        }
      })();
    }

    const refreshPaid = p.get("refresh_paid");
    const awaiting = memberId ? isAwaitingPostPaymentMatching(memberId) : false;

    if (refreshPaid === "1" || (awaiting && refreshPaid !== "0")) {
      void (async () => {
        setRefreshBusy(true);
        setNeedsRefresh(true);
        setOnboardingIncomplete(true);
        scrollDetailsToTop();
        await api(props.apiBase, "/api/onboarding/confirm-checkout", {
          method: "POST",
          token,
          body: JSON.stringify({}),
        }).catch(() => undefined);
        // Poll briefly for Paid/Active like signup
        let confirmed = false;
        for (let i = 0; i < 15; i++) {
          try {
            if (i > 0 && i % 3 === 0) {
              await api(props.apiBase, "/api/onboarding/confirm-checkout", {
                method: "POST",
                token,
                body: JSON.stringify({}),
              }).catch(() => undefined);
            }
            const st = await api(props.apiBase, "/api/onboarding/payment-status", {
              token,
            });
            if (st.paymentConfirmed) {
              confirmed = true;
              break;
            }
          } catch {
            /* retry */
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        const bill = await api(props.apiBase, "/api/member/billing-status", { token });
        setBilling((bill.billing || null) as typeof billing);
        if (confirmed) {
          clearAwaitingPostPaymentMatching();
          setPaymentConfirmed(true);
          setOnboardingIncomplete(true);
          setNeedsRefresh(true);
          setRefreshStep("goal");
          setOk("Payment confirmed — a few matching questions and you’re fully set.");
        } else {
          setRefreshStep("payment");
          setError(
            "We’re still confirming your payment with Stripe. Stay on this page a moment, then continue."
          );
        }
        try {
          const url = new URL(window.location.href);
          url.searchParams.delete("refresh_paid");
          window.history.replaceState({}, "", url.pathname + url.search);
        } catch {
          /* ignore */
        }
        if (mountedRef.current) setRefreshBusy(false);
      })();
    } else if (refreshPaid === "0") {
      setNeedsRefresh(true);
      setOnboardingIncomplete(true);
      setRefreshStep("payment");
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("refresh_paid");
        window.history.replaceState({}, "", url.pathname + url.search);
      } catch {
        /* ignore */
      }
    }
  }, [token, props.apiBase, memberId, sessionId]);

  if (loading) {
    return (
      <div className="wlth-widget">
        <div className="wlth-card wlth-overlay-load">
          <AnimatedLoader
            variant="profile-loading"
            title="Welcome back — loading your profile…"
            description="Gathering your details and matching preferences."
            size="large"
            fullScreen
          />
        </div>
      </div>
    );
  }

  const blocking = saving || reactivating || refreshBusy;
  const blockVariant = reactivating ? "payment-verification" : "profile-updating";
  const blockTitle = reactivating
    ? "Confirming your secure payment…"
    : refreshBusy
      ? "Refreshing your profile…"
      : "Updating your details…";
  const blockDesc = reactivating
    ? "Stripe is completing the final verification. This usually takes only a moment."
    : "Saving your latest profile and matching preferences.";

  // —— Progressive flow: Location → Business → [Payment] → Matching (then COMPLETE) ——
  if (needsRefresh && token && refData) {
    const activePhase = topPhaseForRefreshStep(refreshStep, refreshNeedsPaymentStep);
    const phaseIndex = Math.max(0, refreshTopPhases.indexOf(activePhase));
    const matchSub = MATCHING_REFRESH_STEPS.indexOf(refreshStep);
    const matchSubLabel =
      matchSub >= 0 ? `Matching · ${matchSub + 1} of ${MATCHING_REFRESH_STEPS.length}` : null;

    return (
      <div className="wlth-widget">
        <PageBlockingLoader
          open={blocking}
          variant={
            refreshStep === "payment" && refreshBusy
              ? "payment-verification"
              : blockVariant
          }
          title={
            refreshStep === "payment" && refreshBusy
              ? "Taking you to secure checkout…"
              : blockTitle
          }
          description={blockDesc}
        />
        <div className="wlth-card wlth-step-panel">
          <h1>
            {onboardingIncomplete
              ? "Let’s finish your WLTH WLKS profile"
              : "Keep your profile aligned with where your business is today"}
          </h1>
          <p>
            {onboardingIncomplete
              ? "Your progress is saved as you go — you can leave and pick up from the last step you completed."
              : "A short refresh helps your introductions reflect your current location, business and goals."}
          </p>
          <div className="wlth-refresh-steps" aria-label="Progress">
            {refreshTopPhases.map((s, idx) => {
              const isActive = activePhase === s;
              const isDone = idx < phaseIndex;
              const label =
                s === "location"
                  ? "Location"
                  : s === "business"
                    ? "Business"
                    : s === "payment"
                      ? "Payment"
                      : "Matching";
              return (
                <span
                  key={s}
                  className={`wlth-step-dot ${
                    isActive ? "is-active" : isDone ? "is-done" : ""
                  }`}
                >
                  {label}
                </span>
              );
            })}
          </div>
          {matchSubLabel ? <p className="wlth-subprogress">{matchSubLabel}</p> : null}
          {error && (
            <div className="wlth-banner-error" role="alert">
              {error}
            </div>
          )}
          {ok && <div className="wlth-banner-success">{ok}</div>}

          {refreshStep === "location" && (
            <form onSubmit={onRefreshLocation} noValidate>
              <h2>Where would you like your community to begin?</h2>
              <LocationFields
                countries={refData.countries}
                cities={refreshCities}
                countryRegister={
                  refreshLocation.register("countryCode", {
                    onChange: () => refreshLocation.setValue("cityCode", ""),
                  }) as never
                }
                cityRegister={refreshLocation.register("cityCode") as never}
                countryError={refreshLocation.formState.errors.countryCode?.message as string}
                cityError={refreshLocation.formState.errors.cityCode?.message as string}
                previousCityUnavailable={previousCityUnavailable}
                previousCityLabel={previousCityLabel}
              />
              <div className="wlth-field">
                <label htmlFor="refresh-postcode">Post code</label>
                <input
                  id="refresh-postcode"
                  autoComplete="postal-code"
                  placeholder="Optional"
                  {...refreshLocation.register("postCode")}
                />
                <FieldError
                  message={refreshLocation.formState.errors.postCode?.message as string}
                />
              </div>
              <PhoneField
                phonePrefix={rPhonePrefix}
                phoneRegister={refreshLocation.register("phone") as never}
                prefixError={refreshLocation.formState.errors.phonePrefix as never}
                phoneError={refreshLocation.formState.errors.phone as never}
                idPrefix="refresh-ph"
              />
              <input type="hidden" {...refreshLocation.register("phonePrefix")} />
              <input type="hidden" {...refreshLocation.register("countryIso2")} />
              <AvailabilityFields
                options={refData.availabilityOptions}
                selected={rAvailability}
                onToggle={(code) => {
                  const cur = refreshLocation.getValues("availability") || [];
                  if (cur.includes(code)) {
                    refreshLocation.setValue(
                      "availability",
                      cur.filter((c) => c !== code),
                      { shouldValidate: true }
                    );
                  } else {
                    refreshLocation.setValue("availability", [...cur, code], {
                      shouldValidate: true,
                    });
                  }
                }}
                error={refreshLocation.formState.errors.availability?.message as string}
              />
              <div className="wlth-actions">
                <button type="submit" className="wlth-btn-primary" disabled={refreshBusy}>
                  Continue
                </button>
              </div>
            </form>
          )}

          {refreshStep === "business" && (
            <form onSubmit={onRefreshBusiness} noValidate>
              <h2>Tell us what you’re building</h2>
              <BusinessFields
                industries={refData.industries}
                stages={refData.businessStages}
                revenues={refData.revenueBrackets}
                primaryIndustry={rIndustry}
                industryRegister={refreshBusiness.register("primaryIndustry") as never}
                otherIndustryRegister={refreshBusiness.register("otherIndustry") as never}
                stageRegister={refreshBusiness.register("businessStage") as never}
                revenueRegister={refreshBusiness.register("annualRevenue") as never}
                descriptionRegister={refreshBusiness.register("businessDescription") as never}
                industryError={
                  refreshBusiness.formState.errors.primaryIndustry?.message as string
                }
                otherIndustryError={
                  refreshBusiness.formState.errors.otherIndustry?.message as string
                }
                stageError={refreshBusiness.formState.errors.businessStage?.message as string}
                revenueError={
                  refreshBusiness.formState.errors.annualRevenue?.message as string
                }
                descriptionError={
                  refreshBusiness.formState.errors.businessDescription?.message as string
                }
              />
              <div className="wlth-actions">
                <button
                  type="button"
                  className="wlth-btn-secondary"
                  onClick={() => setRefreshStep("location")}
                >
                  Back
                </button>
                <button type="submit" className="wlth-btn-primary" disabled={refreshBusy}>
                  {refreshNeedsPaymentStep && !paymentConfirmed
                    ? "Continue to payment"
                    : "Continue"}
                </button>
              </div>
            </form>
          )}

          {refreshStep === "payment" && (
            <div className="wlth-pay-hero">
              <h2>Activate your membership</h2>
              <p>
                {billing?.hasPaymentMethod
                  ? "Confirm membership with the card already on file, then we’ll finish your matching preferences."
                  : "Complete a secure Stripe checkout, then a few matching questions so introductions stay relevant."}
              </p>
              <div className="wlth-benefits">
                <p className="wlth-benefit">
                  <strong>Secure payment</strong>
                  Powered by Stripe. We never store your full card details on WLTH WLKS.
                </p>
                <p className="wlth-benefit">
                  <strong>Then matching</strong>
                  After payment you’ll shape the introductions that can move you forward.
                </p>
              </div>
              <div className="wlth-actions">
                <button
                  type="button"
                  className="wlth-btn-secondary"
                  onClick={() => setRefreshStep("business")}
                >
                  Back
                </button>
                {billing?.hasPaymentMethod ? (
                  <button
                    type="button"
                    className="wlth-btn-primary"
                    disabled={refreshBusy}
                    onClick={() => void reactivateFromRefreshPayment()}
                  >
                    Activate with card on file
                  </button>
                ) : (
                  <button
                    type="button"
                    className="wlth-btn-primary"
                    disabled={refreshBusy}
                    onClick={() => void startRefreshCheckout()}
                  >
                    Continue to secure checkout
                  </button>
                )}
              </div>
              <p className="wlth-trust">
                You can manage or cancel anytime from membership settings.
              </p>
            </div>
          )}

          {refreshStep === "goal" && (
            <form onSubmit={onRefreshGoal} noValidate>
              <h2>Let’s shape the introductions that can move you forward</h2>
              <MatchingGoalField
                register={refreshGoal.register("ninetyDayGoal") as never}
                error={refreshGoal.formState.errors.ninetyDayGoal?.message as string}
              />
              <div className="wlth-actions">
                <button
                  type="button"
                  className="wlth-btn-secondary"
                  onClick={() =>
                    setRefreshStep(
                      refreshNeedsPaymentStep && !paymentConfirmed ? "payment" : "business"
                    )
                  }
                >
                  Back
                </button>
                <button type="submit" className="wlth-btn-primary" disabled={refreshBusy}>
                  Continue
                </button>
              </div>
            </form>
          )}

          {refreshStep === "help" && (
            <form onSubmit={onRefreshHelp} noValidate>
              <h2>Where would support help most?</h2>
              <MultiSelectDropdown
                label="Help wanted"
                helperText="Choose up to three areas."
                options={refData.helpWantedOptions}
                value={rHelp}
                onChange={(next) =>
                  refreshHelp.setValue("helpWanted", next, { shouldValidate: true })
                }
                max={3}
              />
              <div className="wlth-field">
                <label htmlFor="rhc">Optional context</label>
                <textarea id="rhc" rows={2} {...refreshHelp.register("helpWantedContext")} />
              </div>
              <div className="wlth-actions">
                <button
                  type="button"
                  className="wlth-btn-secondary"
                  onClick={() => setRefreshStep("goal")}
                >
                  Back
                </button>
                <button type="submit" className="wlth-btn-primary" disabled={refreshBusy}>
                  Continue
                </button>
              </div>
            </form>
          )}

          {refreshStep === "expertise" && (
            <form onSubmit={onRefreshExpertise} noValidate>
              <h2>What can you offer others?</h2>
              <MultiSelectDropdown
                label="Expertise offered"
                helperText="Choose up to five strengths."
                options={refData.expertiseOptions}
                value={rExpertise}
                onChange={(next) =>
                  refreshExpertise.setValue("expertiseOffered", next, {
                    shouldValidate: true,
                  })
                }
                max={5}
              />
              <div className="wlth-field">
                <label htmlFor="rec">Optional context</label>
                <textarea
                  id="rec"
                  rows={2}
                  {...refreshExpertise.register("expertiseContext")}
                />
              </div>
              <div className="wlth-actions">
                <button
                  type="button"
                  className="wlth-btn-secondary"
                  onClick={() => setRefreshStep("help")}
                >
                  Back
                </button>
                <button type="submit" className="wlth-btn-primary" disabled={refreshBusy}>
                  Continue
                </button>
              </div>
            </form>
          )}

          {refreshStep === "connection" && (
            <form onSubmit={onRefreshConnection} noValidate>
              <h2>Connection preference</h2>
              <ConnectionTypeField
                options={refData.connectionTypes}
                register={refreshConnection.register("connectionType") as never}
                error={
                  refreshConnection.formState.errors.connectionType?.message as string
                }
              />
              <div className="wlth-actions">
                <button
                  type="button"
                  className="wlth-btn-secondary"
                  onClick={() => setRefreshStep("expertise")}
                >
                  Back
                </button>
                <button type="submit" className="wlth-btn-primary" disabled={refreshBusy}>
                  Finish
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`wlth-widget${blocking ? " is-blocked" : ""}`}>
      <PageBlockingLoader
        open={blocking}
        variant={blockVariant}
        title={blockTitle}
        description={blockDesc}
      />
      <div className="wlth-card wlth-step-panel wlth-card--relative">
        <h1>Keep your profile aligned with where your business is today</h1>
        <p>Update your details so introductions stay relevant and useful.</p>
        {error && (
          <div className="wlth-banner-error" role="alert">
            {error}
          </div>
        )}
        {ok && <div className="wlth-banner-success">{ok}</div>}

        {!token && <p>Log in to continue.</p>}

        {billing && needsReactivation && (
          <div className="wlth-reactivate">
            <h3>
              {billing.uiState === "cancellation_scheduled"
                ? "Membership cancelled"
                : billing.uiState === "payment_problem"
                  ? "Payment issue"
                  : "Reactivate your membership"}
            </h3>
            {billing.uiState === "cancellation_scheduled" ? (
              <>
                <p className="wlth-muted" style={{ marginBottom: 12 }}>
                  You still have access
                  {billing.accessUntilLabel
                    ? ` until ${billing.accessUntilLabel}`
                    : billing.serviceAccessUntil
                      ? ` until ${String(billing.serviceAccessUntil).slice(0, 10)}`
                      : ""}
                  . Your membership will not renew after this date.
                </p>
                <p className="wlth-muted" style={{ marginBottom: 12 }}>
                  Reactivate to continue without interruption — you will not be charged today.
                </p>
              </>
            ) : billing.uiState === "payment_problem" ? (
              <p className="wlth-muted" style={{ marginBottom: 12 }}>
                {billing.hasServiceAccess
                  ? "Your payment needs attention but you still have access."
                  : "Your payment has failed. Update your card to restore access."}{" "}
                Use Manage billing to update your payment method.
              </p>
            ) : billing.uiState === "expired" ? (
              <p className="wlth-muted" style={{ marginBottom: 12 }}>
                Your membership has ended. Reactivate charges the card already on file when
                possible. Use Manage billing to change cards.
              </p>
            ) : (
              <p className="wlth-muted" style={{ marginBottom: 12 }}>
                Your membership is not fully active
                {billing.membership ? ` (${billing.membership}` : ""}
                {billing.payment
                  ? `${billing.membership ? " · " : " ("}${billing.payment}`
                  : ""}
                {billing.membership || billing.payment ? ")" : ""}. Reactivate charges the card
                already on file when possible. Use Manage billing to change cards or cancel.
              </p>
            )}
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                disabled={reactivating}
                onClick={() => void reactivateMembership()}
              >
                Reactivate membership
              </button>
              <button
                type="button"
                className="wlth-btn-secondary"
                onClick={() => void openPortal()}
              >
                Manage billing
              </button>
            </div>
          </div>
        )}

        {token && refData && (
          <>
            <form
              id="wlth-update-profile-form"
              className="wlth-form-pad-bottom"
              onSubmit={onSave}
              noValidate
            >
              <p className="wlth-section-title">Personal</p>
              <div className="wlth-grid-2">
                <div className="wlth-field">
                  <label htmlFor="fn">First name</label>
                  <input id="fn" {...form.register("firstName")} />
                  <FieldError message={form.formState.errors.firstName?.message} />
                </div>
                <div className="wlth-field">
                  <label htmlFor="ln">Last name</label>
                  <input id="ln" {...form.register("lastName")} />
                  <FieldError message={form.formState.errors.lastName?.message} />
                </div>
              </div>
              <div className="wlth-field">
                <label htmlFor="em">Email</label>
                <input id="em" type="email" {...form.register("email")} />
                <FieldError message={form.formState.errors.email?.message} />
              </div>
              <div className="wlth-field">
                <label htmlFor="upd-headline">Professional headline</label>
                <input
                  id="upd-headline"
                  placeholder="e.g. Founder & CEO, Brand Strategist"
                  maxLength={80}
                  {...form.register("professionalHeadline")}
                />
                <FieldError message={form.formState.errors.professionalHeadline?.message} />
              </div>
              <div className="wlth-field">
                <label htmlFor="upd-bio">About me</label>
                <textarea
                  id="upd-bio"
                  rows={3}
                  maxLength={500}
                  placeholder="Tell other members a little about who you are and what you do."
                  {...form.register("profileBio")}
                />
                <FieldError message={form.formState.errors.profileBio?.message} />
              </div>

              <p className="wlth-section-title">Location & availability</p>
              <LocationFields
                countries={refData.countries}
                cities={cities}
                countryRegister={
                  form.register("countryCode", {
                    onChange: () => form.setValue("cityCode", "", { shouldDirty: true }),
                  }) as never
                }
                cityRegister={form.register("cityCode") as never}
                previousCityUnavailable={previousCityUnavailable}
                previousCityLabel={previousCityLabel}
              />
              <div className="wlth-field">
                <label htmlFor="upd-postcode">Post code</label>
                <input
                  id="upd-postcode"
                  autoComplete="postal-code"
                  placeholder="Optional"
                  {...form.register("postCode")}
                />
                <FieldError message={form.formState.errors.postCode?.message} />
              </div>
              <PhoneField
                phonePrefix={phonePrefix}
                phoneRegister={form.register("phone")}
                prefixError={form.formState.errors.phonePrefix}
                phoneError={form.formState.errors.phone}
                idPrefix="upd-ph"
              />
              <input type="hidden" {...form.register("phonePrefix")} />
              <input type="hidden" {...form.register("countryIso2")} />
              <AvailabilityFields
                options={refData.availabilityOptions}
                selected={availability}
                onToggle={(code) => {
                  const cur = form.getValues("availability") || [];
                  if (cur.includes(code)) {
                    form.setValue(
                      "availability",
                      cur.filter((c) => c !== code),
                      { shouldDirty: true }
                    );
                  } else if (cur.length < 21) {
                    form.setValue("availability", [...cur, code], { shouldDirty: true });
                  }
                }}
              />

              <p className="wlth-section-title">Business</p>
              <div className="wlth-field">
                <label htmlFor="upd-bizname">Business name</label>
                <input
                  id="upd-bizname"
                  placeholder="Your company or brand name"
                  maxLength={120}
                  {...form.register("businessName")}
                />
                <FieldError message={form.formState.errors.businessName?.message} />
              </div>
              <div className="wlth-field">
                <label htmlFor="upd-bizweb">Business website</label>
                <input
                  id="upd-bizweb"
                  placeholder="yourbusiness.com"
                  {...form.register("businessWebsite")}
                  onChange={(e) => {
                    form.register("businessWebsite").onChange(e);
                    if (webError) setWebError("");
                  }}
                />
                <FieldError message={webError || form.formState.errors.businessWebsite?.message} />
              </div>
              <BusinessFields
                industries={refData.industries}
                stages={refData.businessStages}
                revenues={refData.revenueBrackets}
                primaryIndustry={primaryIndustry}
                industryRegister={form.register("primaryIndustry") as never}
                otherIndustryRegister={form.register("otherIndustry") as never}
                stageRegister={form.register("businessStage") as never}
                revenueRegister={form.register("annualRevenue") as never}
                descriptionRegister={form.register("businessDescription") as never}
                industryError={form.formState.errors.primaryIndustry?.message}
                otherIndustryError={form.formState.errors.otherIndustry?.message}
                stageError={form.formState.errors.businessStage?.message}
                revenueError={form.formState.errors.annualRevenue?.message}
                descriptionError={form.formState.errors.businessDescription?.message}
              />

              <p className="wlth-section-title">Matching preferences</p>
              <MatchingGoalField
                register={form.register("ninetyDayGoal") as never}
                error={form.formState.errors.ninetyDayGoal?.message}
              />
              <MultiSelectDropdown
                label="Help wanted"
                helperText="Choose up to three areas."
                options={refData.helpWantedOptions}
                value={helpWanted}
                onChange={(next) =>
                  form.setValue("helpWanted", next, { shouldDirty: true, shouldValidate: true })
                }
                max={3}
              />
              <div className="wlth-field">
                <label htmlFor="hw">Help wanted context (optional)</label>
                <textarea id="hw" rows={2} {...form.register("helpWantedContext")} />
                <FieldError message={form.formState.errors.helpWantedContext?.message} />
              </div>
              <MultiSelectDropdown
                label="Expertise offered"
                helperText="Choose up to five strengths."
                options={refData.expertiseOptions}
                value={expertiseOffered}
                onChange={(next) =>
                  form.setValue("expertiseOffered", next, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
                max={5}
              />
              <div className="wlth-field">
                <label htmlFor="ex">Expertise context (optional)</label>
                <textarea id="ex" rows={2} {...form.register("expertiseContext")} />
                <FieldError message={form.formState.errors.expertiseContext?.message} />
              </div>
              <ConnectionTypeField
                options={refData.connectionTypes}
                register={form.register("connectionType") as never}
                error={form.formState.errors.connectionType?.message}
              />
              <div className="wlth-field">
                <label htmlFor="td">Topics to discuss</label>
                <textarea id="td" rows={2} {...form.register("topicsToDiscuss")} />
                <FieldError message={form.formState.errors.topicsToDiscuss?.message} />
              </div>

              <p className="wlth-section-title">Links</p>
              <p className="wlth-muted">Add your social profiles and links so members can connect.</p>
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
                    id={"upd-social-" + link.platform}
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
              {!addingSocialPlatform ? (
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
              ) : (
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
                    onClick={() => {
                      setAddingSocialPlatform(false);
                      setSocialError("");
                    }}
                  >
                    Cancel
                  </button>
                </div>
              )}

              <div className="wlth-sticky-save">
                <span
                  className={`wlth-sticky-save__status ${
                    saveStatus === "dirty"
                      ? "is-dirty"
                      : saveStatus === "saved"
                        ? "is-saved"
                        : ""
                  }`}
                >
                  {saving
                    ? "Saving…"
                    : saveStatus === "dirty"
                      ? "Unsaved changes"
                      : saveStatus === "saved"
                        ? "All changes saved"
                        : "No changes yet"}
                </span>
                <div className="wlth-actions" style={{ marginTop: 0 }}>
                  <button
                    type="submit"
                    form="wlth-update-profile-form"
                    className="wlth-btn-primary"
                    disabled={saving || (!isDirty && saveStatus !== "dirty")}
                  >
                    Save changes
                  </button>
                  {!needsReactivation && (
                    <button
                      type="button"
                      className="wlth-btn-secondary"
                      onClick={() => void openPortal()}
                    >
                      Manage billing
                    </button>
                  )}
                </div>
              </div>
            </form>

            <form onSubmit={onPassword} noValidate style={{ marginTop: 28 }}>
              <p className="wlth-section-title">Change password</p>
              <div className="wlth-field">
                <label htmlFor="curPw">Current password</label>
                <input
                  id="curPw"
                  type="password"
                  autoComplete="current-password"
                  {...pwForm.register("currentPassword")}
                />
                <FieldError message={pwForm.formState.errors.currentPassword?.message} />
              </div>
              <div className="wlth-grid-2">
                <div className="wlth-field">
                  <label htmlFor="newPw">New password</label>
                  <input
                    id="newPw"
                    type="password"
                    autoComplete="new-password"
                    {...pwForm.register("newPassword")}
                  />
                  <FieldError message={pwForm.formState.errors.newPassword?.message} />
                </div>
                <div className="wlth-field">
                  <label htmlFor="confPw">Confirm new password</label>
                  <input
                    id="confPw"
                    type="password"
                    autoComplete="new-password"
                    {...pwForm.register("confirmPassword")}
                  />
                  <FieldError message={pwForm.formState.errors.confirmPassword?.message} />
                </div>
              </div>
              <div className="wlth-actions">
                <button type="submit" className="wlth-btn-secondary" disabled={pwSaving}>
                  {pwSaving ? "Updating…" : "Update password"}
                </button>
              </div>
            </form>
          </>
        )}

        {billing && (
          <p className="wlth-muted" style={{ marginTop: 20 }}>
            {billing.uiState === "active" ? (
              <>
                Membership active
                {billing.currentPeriodEnd
                  ? ` — renews on ${billing.currentPeriodEnd}`
                  : ""}
              </>
            ) : (
              <>
                Membership: {billing.membership || "—"} · Payment: {billing.payment || "—"}
              </>
            )}
            {billing.accessUntilLabel
              ? ` · Access until ${billing.accessUntilLabel}`
              : billing.serviceAccessUntil
                ? ` · Access until ${String(billing.serviceAccessUntil).slice(0, 10)}`
                : ""}
            {billing.cancelAtPeriodEnd && billing.uiState !== "cancellation_scheduled"
              ? " · Cancellation scheduled"
              : ""}
          </p>
        )}
      </div>
    </div>
  );
}
