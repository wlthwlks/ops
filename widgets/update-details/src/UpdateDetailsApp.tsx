import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { widgetApi } from "../../shared/api";
import {
  changeMemberstackPassword,
  logMemberstackDiagnostics,
  tryResolveSessionAccessToken,
} from "../../shared/memberstack-auth";
import { AnimatedLoader } from "../../shared/AnimatedLoader";
import { PageBlockingLoader } from "../../shared/PageBlockingLoader";
import { PhoneField, dialCodeForCountryCode } from "../../shared/PhoneField";
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
  isProfileRefreshComplete,
  markProfileRefreshComplete,
  decodeJwtPayload,
} from "../../shared/session-refresh-gate";

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

type RefreshStep = "location" | "business" | "matching";

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
  } | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [refreshStep, setRefreshStep] = useState<RefreshStep>("location");
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [previousCityUnavailable, setPreviousCityUnavailable] = useState(false);
  const [previousCityLabel, setPreviousCityLabel] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "dirty" | "saved">("idle");
  const phonePrefixManual = useRef(false);
  const mountedRef = useRef(true);

  const form = useForm<ProfileForm>({
    resolver: zodResolver(profileFormSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      phonePrefix: "",
      countryCode: "",
      cityCode: "",
      availability: [],
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
    },
    mode: "onBlur",
  });

  const refreshLocation = useForm({
    resolver: zodResolver(locationFormSchema),
    defaultValues: { countryCode: "", cityCode: "", availability: [] as string[] },
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

        const [cfg, ref, profileRes, bill] = await Promise.all([
          api(props.apiBase, "/api/forms/config"),
          api(props.apiBase, "/api/reference-data/onboarding"),
          api(props.apiBase, "/api/member/profile", { token: t }),
          api(props.apiBase, "/api/member/billing-status", { token: t }),
        ]);
        const rd = ref as unknown as RefData;
        setRefData(rd);
        setMembershipPriceId(
          String((cfg as { membershipPriceId?: string }).membershipPriceId || "")
        );
        const p = (profileRes.profile || {}) as Record<string, unknown>;

        const cityUnavailable = Boolean(p.previousCityUnavailable);
        setPreviousCityUnavailable(cityUnavailable);
        setPreviousCityLabel(String(p.previousCityLabel || p.city || ""));

        const defaults: ProfileForm = {
          firstName: String(p.firstName || ""),
          lastName: String(p.lastName || ""),
          email: String(p.email || ""),
          phone: String(p.phone || ""),
          phonePrefix: String(p.phonePrefix || ""),
          countryCode: String(p.countryCode || ""),
          cityCode: cityUnavailable ? "" : String(p.cityCode || ""),
          availability: Array.isArray(p.availability) ? (p.availability as string[]) : [],
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
        };
        form.reset(defaults);

        refreshLocation.reset({
          countryCode: defaults.countryCode || "",
          cityCode: defaults.cityCode || "",
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

        const done =
          mid && sid ? isProfileRefreshComplete({ memberId: mid, sessionId: sid }) : false;
        setNeedsRefresh(!done);

        setBilling(
          (bill.billing || null) as {
            membership: string;
            payment: string;
            serviceAccessUntil: string;
            cancelAtPeriodEnd: boolean;
            cancellationEffectiveAt: string;
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
    const mem = (billing.membership || "").toLowerCase();
    const pay = (billing.payment || "").toLowerCase();
    if (pay === "paid" && mem === "active" && !billing.cancelAtPeriodEnd) return false;
    if (mem === "pending payment" || pay === "unpaid" || pay === "failed") return true;
    if (billing.cancelAtPeriodEnd) return true;
    if (mem && mem !== "active") return true;
    if (pay && pay !== "paid") return true;
    return false;
  }, [billing]);

  const scrollDetailsToTop = () => {
    try {
      const root =
        document.getElementById("wlth-update-details-root") ||
        document.querySelector(".wlth-widget");
      if (root) {
        root.scrollIntoView({ behavior: "smooth", block: "start" });
        const rect = root.getBoundingClientRect();
        window.scrollTo({
          top: Math.max(0, window.scrollY + rect.top - 12),
          behavior: "smooth",
        });
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
  };

  const patchProfile = async (body: Record<string, unknown>) => {
    if (!token) throw new Error("Not signed in");
    return api(props.apiBase, "/api/member/profile", {
      method: "PATCH",
      token,
      body: JSON.stringify(body),
    });
  };

  const completeRefresh = async (payload: Record<string, unknown>) => {
    setRefreshBusy(true);
    setError(null);
    try {
      await patchProfile(payload);
      if (memberId && sessionId) {
        markProfileRefreshComplete({ memberId, sessionId });
      }
      // Sync main form from refresh answers
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
        connectionType: String(
          payload.connectionType ?? form.getValues("connectionType") ?? ""
        ),
      });
      setNeedsRefresh(false);
      setOk(
        "Your profile is refreshed — your future introductions can now reflect where you are and what you need today."
      );
      setSaveStatus("saved");
      scrollDetailsToTop();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not refresh profile");
    } finally {
      if (mountedRef.current) setRefreshBusy(false);
    }
  };

  const onRefreshLocation = refreshLocation.handleSubmit(async (values) => {
    setError(null);
    setRefreshBusy(true);
    try {
      // Save location now via profile (not onboarding/step)
      await patchProfile({
        countryCode: values.countryCode,
        cityCode: values.cityCode,
        availability: values.availability,
      });
      form.setValue("countryCode", values.countryCode);
      form.setValue("cityCode", values.cityCode);
      form.setValue("availability", values.availability);
      if (!phonePrefixManual.current && refData) {
        const dial = dialCodeForCountryCode(refData.countries, values.countryCode);
        if (dial) form.setValue("phonePrefix", dial);
      }
      setPreviousCityUnavailable(false);
      setRefreshStep("business");
      scrollDetailsToTop();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save location");
    } finally {
      if (mountedRef.current) setRefreshBusy(false);
    }
  });

  const onRefreshBusiness = refreshBusiness.handleSubmit(async (values) => {
    setError(null);
    setRefreshBusy(true);
    try {
      await patchProfile({
        primaryIndustry: values.primaryIndustry,
        otherIndustry: values.otherIndustry,
        businessStage: values.businessStage,
        annualRevenue: values.annualRevenue,
        businessDescription: values.businessDescription,
      });
      form.setValue("primaryIndustry", values.primaryIndustry);
      form.setValue("otherIndustry", values.otherIndustry || "");
      form.setValue("businessStage", values.businessStage);
      form.setValue("annualRevenue", values.annualRevenue);
      form.setValue("businessDescription", values.businessDescription);
      setRefreshStep("matching");
      scrollDetailsToTop();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save business details");
    } finally {
      if (mountedRef.current) setRefreshBusy(false);
    }
  });

  const onRefreshMatching = async () => {
    const goalOk = await refreshGoal.trigger();
    const helpOk = await refreshHelp.trigger();
    const expOk = await refreshExpertise.trigger();
    const connOk = await refreshConnection.trigger();
    if (!goalOk || !helpOk || !expOk || !connOk) return;

    const goal = refreshGoal.getValues();
    const help = refreshHelp.getValues();
    const exp = refreshExpertise.getValues();
    const conn = refreshConnection.getValues();

    await completeRefresh({
      ninetyDayGoal: goal.ninetyDayGoal,
      helpWanted: help.helpWanted || [],
      helpWantedContext: help.helpWantedContext || "",
      expertiseOffered: exp.expertiseOffered || [],
      expertiseContext: exp.expertiseContext || "",
      connectionType: conn.connectionType,
    });
  };

  const onSave = form.handleSubmit(async (values) => {
    if (!token || saving) return;
    setSaving(true);
    scrollDetailsToTop();
    setError(null);
    setOk(null);
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
          countryCode: values.countryCode || undefined,
          cityCode: values.cityCode || undefined,
          availability: values.availability ?? [],
          primaryIndustry: values.primaryIndustry || undefined,
          otherIndustry: values.otherIndustry ?? "",
          businessStage: values.businessStage || undefined,
          annualRevenue: values.annualRevenue || undefined,
          businessDescription: values.businessDescription || undefined,
          ninetyDayGoal: values.ninetyDayGoal || undefined,
          // Explicit arrays/strings so empty clears Airtable
          helpWanted: values.helpWanted ?? [],
          helpWantedContext: values.helpWantedContext ?? "",
          expertiseOffered: values.expertiseOffered ?? [],
          expertiseContext: values.expertiseContext ?? "",
          connectionType: values.connectionType || undefined,
          topicsToDiscuss: values.topicsToDiscuss ?? "",
        }),
      });
      const p = (res.profile || {}) as Record<string, unknown>;
      form.reset({
        firstName: String(p.firstName ?? values.firstName),
        lastName: String(p.lastName ?? values.lastName),
        email: String(p.email ?? values.email),
        phone: String(p.phone ?? values.phone ?? ""),
        phonePrefix: String(p.phonePrefix ?? values.phonePrefix ?? ""),
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
      });
      setPreviousCityUnavailable(Boolean(p.previousCityUnavailable));
      setOk("Your profile is up to date and ready for stronger introductions.");
      setSaveStatus("saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  });

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
    await w.$memberstackDom.launchStripeCustomerPortal();
  };

  const reactivateMembership = async () => {
    if (!token) return;
    setReactivating(true);
    scrollDetailsToTop();
    setError(null);
    setOk(null);
    try {
      const res = await api(props.apiBase, "/api/member/reactivate", {
        method: "POST",
        token,
        body: JSON.stringify({}),
      });
      if (!res.success) {
        if (
          res.status === "no_payment_method" ||
          res.status === "no_stripe_customer"
        ) {
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
            setError(String(res.reason || "Could not reactivate membership"));
            return;
          }
          const base = window.location.origin + window.location.pathname;
          await w.$memberstackDom.purchasePlansWithCheckout({
            priceId: membershipPriceId,
            successUrl: `${base}?reactivated=1`,
            cancelUrl: `${base}?reactivated=0`,
          });
          await api(props.apiBase, "/api/onboarding/confirm-checkout", {
            method: "POST",
            token,
            body: JSON.stringify({}),
          }).catch(() => undefined);
        } else {
          setError(String(res.reason || "Could not reactivate membership"));
          return;
        }
      } else {
        setOk(String(res.reason || "Membership reactivated with your card on file."));
      }
      const bill = await api(props.apiBase, "/api/member/billing-status", { token });
      setBilling((bill.billing || null) as typeof billing);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg && !/cancel|closed|abort/i.test(msg)) setError(msg);
    } finally {
      if (mountedRef.current) setReactivating(false);
    }
  };

  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get("reactivated") === "1" && token) {
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
  }, [token, props.apiBase]);

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

  // —— Mandatory profile refresh (Location → Business → Matching) ——
  if (needsRefresh && token && refData) {
    return (
      <div className="wlth-widget">
        <PageBlockingLoader
          open={blocking}
          variant={blockVariant}
          title={blockTitle}
          description={blockDesc}
        />
        <div className="wlth-card wlth-step-panel">
          <h1>Keep your profile aligned with where your business is today</h1>
          <p>
            A short refresh helps your introductions reflect your current location, business
            and goals. This won’t change billing or create a new account.
          </p>
          <div className="wlth-refresh-steps" aria-label="Refresh progress">
            {(["location", "business", "matching"] as const).map((s) => (
              <span
                key={s}
                className={`wlth-step-dot ${
                  refreshStep === s
                    ? "is-active"
                    : (s === "location" && refreshStep !== "location") ||
                        (s === "business" && refreshStep === "matching")
                      ? "is-done"
                      : ""
                }`}
              >
                {s === "location" ? "Location" : s === "business" ? "Business" : "Matching"}
              </span>
            ))}
          </div>
          {error && (
            <div className="wlth-banner-error" role="alert">
              {error}
            </div>
          )}

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
                  Continue
                </button>
              </div>
            </form>
          )}

          {refreshStep === "matching" && (
            <div>
              <h2>Let’s shape the introductions that can move you forward</h2>
              <MatchingGoalField
                register={refreshGoal.register("ninetyDayGoal") as never}
                error={refreshGoal.formState.errors.ninetyDayGoal?.message as string}
              />
              <MultiSelectDropdown
                label="Where would support make the biggest difference?"
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
              <MultiSelectDropdown
                label="What expertise can you offer others?"
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
                  onClick={() => setRefreshStep("business")}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="wlth-btn-primary"
                  disabled={refreshBusy}
                  onClick={() => void onRefreshMatching()}
                >
                  Save and continue
                </button>
              </div>
            </div>
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
            <h3>Reactivate your membership</h3>
            <p className="wlth-muted" style={{ marginBottom: 12 }}>
              Your membership is not fully active
              {billing.membership ? ` (${billing.membership}` : ""}
              {billing.payment
                ? `${billing.membership ? " · " : " ("}${billing.payment}`
                : ""}
              {billing.membership || billing.payment ? ")" : ""}. Reactivate charges the card
              already on file when possible. Use Manage billing to change cards or cancel.
            </p>
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
              <PhoneField
                countries={refData.countries}
                phonePrefix={phonePrefix}
                phoneRegister={form.register("phone")}
                onPrefixChange={(dial) => {
                  phonePrefixManual.current = true;
                  form.setValue("phonePrefix", dial, {
                    shouldDirty: true,
                    shouldValidate: true,
                  });
                }}
                prefixError={form.formState.errors.phonePrefix}
                phoneError={form.formState.errors.phone}
                idPrefix="upd-ph"
              />
              <input type="hidden" {...form.register("phonePrefix")} />

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
                otherIndustryError={form.formState.errors.otherIndustry?.message}
              />

              <p className="wlth-section-title">Matching preferences</p>
              <MatchingGoalField register={form.register("ninetyDayGoal") as never} />
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
              </div>
              <ConnectionTypeField
                options={refData.connectionTypes}
                register={form.register("connectionType") as never}
              />
              <div className="wlth-field">
                <label htmlFor="td">Topics to discuss</label>
                <textarea id="td" rows={2} {...form.register("topicsToDiscuss")} />
              </div>

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
                    disabled={saving || !isDirty}
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
            Membership: {billing.membership || "—"} · Payment: {billing.payment || "—"}
            {billing.serviceAccessUntil
              ? ` · Access until ${billing.serviceAccessUntil.slice(0, 10)}`
              : ""}
            {billing.cancelAtPeriodEnd ? " · Cancellation scheduled" : ""}
          </p>
        )}
      </div>
    </div>
  );
}
