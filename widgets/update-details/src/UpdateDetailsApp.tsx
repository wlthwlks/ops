import { useEffect, useMemo, useState } from "react";
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

const profileSchema = z.object({
  firstName: z.string().trim().min(1, "Required").max(80),
  lastName: z.string().trim().min(1, "Required").max(80),
  email: z
    .string()
    .trim()
    .email()
    .transform((e) => e.toLowerCase()),
  phone: z.string().trim().max(40).optional(),
  countryCode: z.string().min(10).max(64).optional().or(z.literal("")),
  cityCode: z.string().max(64).optional(),
  availability: z.array(z.string()).max(21).optional(),
  primaryIndustry: z.string().optional(),
  businessStage: z.string().optional(),
  annualRevenue: z.string().optional(),
  businessDescription: z.string().trim().max(400).optional(),
  ninetyDayGoal: z.string().trim().max(300).optional(),
  helpWanted: z.array(z.string()).max(3).optional(),
  helpWantedContext: z.string().trim().max(400).optional(),
  expertiseOffered: z.array(z.string()).max(5).optional(),
  expertiseContext: z.string().trim().max(400).optional(),
  connectionType: z.string().optional(),
  topicsToDiscuss: z.string().trim().max(1000).optional(),
});

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

type ProfileForm = z.infer<typeof profileSchema>;
type PasswordForm = z.infer<typeof passwordSchema>;

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

async function api(base: string, path: string, opts: RequestInit & { token?: string } = {}) {
  return widgetApi(base, path, opts) as Promise<Record<string, unknown>>;
}

function FieldError({ message }: { message?: string }) {
  return <div className="wlth-error">{message || "\u00a0"}</div>;
}

/** Recover selected codes stored inside a free-text context field. */
function parseCodesFromContext(
  context: string,
  options: Array<{ code: string }>
): { codes: string[]; rest: string } {
  const known = new Set(options.map((o) => o.code));
  const parts = context
    .split(/[,;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const codes: string[] = [];
  const restParts: string[] = [];
  for (const p of parts) {
    if (known.has(p)) codes.push(p);
    else restParts.push(p);
  }
  return { codes, rest: restParts.join(", ") };
}

export function UpdateDetailsApp(props: { apiBase: string }) {
  const [token, setToken] = useState<string | null>(null);
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

  const form = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      countryCode: "",
      cityCode: "",
      availability: [],
      primaryIndustry: "",
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

  const pwForm = useForm<PasswordForm>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const countryCode = form.watch("countryCode");

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
        const [cfg, ref, profileRes, bill] = await Promise.all([
          api(props.apiBase, "/api/forms/config"),
          api(props.apiBase, "/api/reference-data/onboarding"),
          api(props.apiBase, "/api/member/profile", { token: t }),
          api(props.apiBase, "/api/member/billing-status", { token: t }),
        ]);
        const rd = ref as unknown as RefData;
        setRefData(rd);
        setMembershipPriceId(String((cfg as { membershipPriceId?: string }).membershipPriceId || ""));
        const p = (profileRes.profile || {}) as Record<string, unknown>;
        const helpCtx = String(p.helpWantedContext || "");
        const expCtx = String(p.expertiseContext || "");
        const helpParsed = parseCodesFromContext(helpCtx, rd.helpWantedOptions || []);
        const expParsed = parseCodesFromContext(expCtx, rd.expertiseOptions || []);
        form.reset({
          firstName: String(p.firstName || ""),
          lastName: String(p.lastName || ""),
          email: String(p.email || ""),
          phone: String(p.phone || ""),
          countryCode: String(p.countryCode || "") || rd.countries?.[0]?.code || "",
          cityCode: String(p.cityCode || ""),
          availability: Array.isArray(p.availability) ? (p.availability as string[]) : [],
          primaryIndustry: String(p.primaryIndustry || ""),
          businessStage: String(p.businessStage || ""),
          annualRevenue: String(p.annualRevenue || ""),
          businessDescription: String(p.businessDescription || ""),
          ninetyDayGoal: String(p.ninetyDayGoal || ""),
          helpWanted: Array.isArray(p.helpWanted)
            ? (p.helpWanted as string[])
            : helpParsed.codes,
          helpWantedContext: helpParsed.rest || (helpParsed.codes.length ? "" : helpCtx),
          expertiseOffered: Array.isArray(p.expertiseOffered)
            ? (p.expertiseOffered as string[])
            : expParsed.codes,
          expertiseContext: expParsed.rest || (expParsed.codes.length ? "" : expCtx),
          connectionType: String(p.connectionType || ""),
          topicsToDiscuss: String(p.topicsToDiscuss || ""),
        });
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

  const toggleMulti = (
    field: "availability" | "helpWanted" | "expertiseOffered",
    code: string,
    max: number
  ) => {
    const cur = form.getValues(field) || [];
    if (cur.includes(code)) {
      form.setValue(
        field,
        cur.filter((c) => c !== code),
        { shouldDirty: true }
      );
    } else if (cur.length < max) {
      form.setValue(field, [...cur, code], { shouldDirty: true });
    }
  };

  const onSave = form.handleSubmit(async (values) => {
    if (!token) return;
    setSaving(true);
    setError(null);
    setOk(null);
    try {
      await api(props.apiBase, "/api/member/email", {
        method: "POST",
        token,
        body: JSON.stringify({ email: values.email }),
      });
      await api(props.apiBase, "/api/member/profile", {
        method: "PATCH",
        token,
        body: JSON.stringify({
          firstName: values.firstName,
          lastName: values.lastName,
          phone: values.phone,
          countryCode: values.countryCode || undefined,
          cityCode: values.cityCode || undefined,
          availability: values.availability?.length ? values.availability : undefined,
          primaryIndustry: values.primaryIndustry || undefined,
          businessStage: values.businessStage || undefined,
          annualRevenue: values.annualRevenue || undefined,
          businessDescription: values.businessDescription || undefined,
          ninetyDayGoal: values.ninetyDayGoal || undefined,
          helpWanted: values.helpWanted?.length ? values.helpWanted : undefined,
          helpWantedContext: values.helpWantedContext || undefined,
          expertiseOffered: values.expertiseOffered?.length
            ? values.expertiseOffered
            : undefined,
          expertiseContext: values.expertiseContext || undefined,
          connectionType: values.connectionType || undefined,
          topicsToDiscuss: values.topicsToDiscuss || undefined,
        }),
      });
      setOk("Your profile has been updated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
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

  /**
   * One-click reactivate with card on file (server charges Stripe customer).
   * Manage billing stays separate for cards / cancel.
   */
  const reactivateMembership = async () => {
    if (!token) return;
    setReactivating(true);
    setError(null);
    setOk(null);
    try {
      const res = await api(props.apiBase, "/api/member/reactivate", {
        method: "POST",
        token,
        body: JSON.stringify({}),
      });
      if (!res.success) {
        // No card / no customer → Memberstack checkout once to save a card
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
      setReactivating(false);
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
            title="Welcome back! We’re loading your profile…"
            description="Gathering your details and matching preferences."
            size="large"
            fullScreen
          />
        </div>
      </div>
    );
  }

  if (saving || reactivating) {
    return (
      <div className="wlth-widget">
        <div className="wlth-card wlth-overlay-load">
          <AnimatedLoader
            variant={reactivating ? "payment-verification" : "profile-updating"}
            title={
              reactivating
                ? "Confirming your secure payment…"
                : "Updating your details…"
            }
            description={
              reactivating
                ? "Stripe is completing the final verification. This usually takes only a moment."
                : "Saving your latest profile and matching preferences."
            }
            size="medium"
            fullScreen
          />
        </div>
      </div>
    );
  }

  return (
    <div className="wlth-widget">
      <div className="wlth-card wlth-step-panel">
        <h1>Update details</h1>
        <p>Keep your WLTH WLKS profile current so introductions stay relevant.</p>
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
              {billing.payment ? `${billing.membership ? " · " : " ("}${billing.payment}` : ""}
              {billing.membership || billing.payment ? ")" : ""}. Reactivate charges the card already
              on file when possible. Use Manage billing to change cards or cancel.
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
              <button type="button" className="wlth-btn-secondary" onClick={() => void openPortal()}>
                Manage billing
              </button>
            </div>
          </div>
        )}

        {token && refData && (
          <>
            <form onSubmit={onSave} noValidate>
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
              <div className="wlth-grid-2">
                <div className="wlth-field">
                  <label htmlFor="em">Email</label>
                  <input id="em" type="email" {...form.register("email")} />
                  <FieldError message={form.formState.errors.email?.message} />
                </div>
                <div className="wlth-field">
                  <label htmlFor="ph">Phone</label>
                  <input id="ph" {...form.register("phone")} />
                </div>
              </div>

              <p className="wlth-section-title">Location & availability</p>
              <div className="wlth-grid-2">
                <div className="wlth-field">
                  <label htmlFor="co">Country</label>
                  <select
                    id="co"
                    {...form.register("countryCode", {
                      onChange: () => form.setValue("cityCode", ""),
                    })}
                  >
                    <option value="">Select</option>
                    {refData.countries.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="wlth-field">
                  <label htmlFor="ci">City</label>
                  <select id="ci" {...form.register("cityCode")}>
                    <option value="">Select</option>
                    {cities.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <p className="wlth-muted">Availability (select all that apply)</p>
              <div className="wlth-check-grid">
                {(refData.availabilityOptions || []).map((o) => {
                  const selected = form.watch("availability") || [];
                  return (
                    <label key={o.code} className="wlth-check">
                      <input
                        type="checkbox"
                        checked={selected.includes(o.code)}
                        onChange={() => toggleMulti("availability", o.code, 21)}
                      />
                      <span>{o.label}</span>
                    </label>
                  );
                })}
              </div>

              <p className="wlth-section-title">Business</p>
              <div className="wlth-grid-2">
                <div className="wlth-field">
                  <label htmlFor="ind">Industry</label>
                  <select id="ind" {...form.register("primaryIndustry")}>
                    <option value="">Select</option>
                    {refData.industries.map((i) => (
                      <option key={i.code} value={i.code}>
                        {i.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="wlth-field">
                  <label htmlFor="st">Stage</label>
                  <select id="st" {...form.register("businessStage")}>
                    <option value="">Select</option>
                    {refData.businessStages.map((i) => (
                      <option key={i.code} value={i.code}>
                        {i.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="wlth-field">
                <label htmlFor="rv">Revenue</label>
                <select id="rv" {...form.register("annualRevenue")}>
                  <option value="">Select</option>
                  {refData.revenueBrackets.map((i) => (
                    <option key={i.code} value={i.code}>
                      {i.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="wlth-field">
                <label htmlFor="bd">Business description</label>
                <textarea id="bd" rows={3} {...form.register("businessDescription")} />
              </div>

              <p className="wlth-section-title">Matching preferences</p>
              <div className="wlth-field">
                <label htmlFor="g">Current 90-day goal</label>
                <textarea id="g" rows={3} {...form.register("ninetyDayGoal")} />
              </div>

              <p className="wlth-muted">Help wanted (select up to 3)</p>
              <div className="wlth-check-grid">
                {(refData.helpWantedOptions || []).map((o) => {
                  const selected = form.watch("helpWanted") || [];
                  return (
                    <label key={o.code} className="wlth-check">
                      <input
                        type="checkbox"
                        checked={selected.includes(o.code)}
                        onChange={() => toggleMulti("helpWanted", o.code, 3)}
                      />
                      <span>{o.label}</span>
                    </label>
                  );
                })}
              </div>
              <div className="wlth-field">
                <label htmlFor="hw">Help wanted context (optional)</label>
                <textarea id="hw" rows={2} {...form.register("helpWantedContext")} />
              </div>

              <p className="wlth-muted">Expertise offered (select up to 5)</p>
              <div className="wlth-check-grid">
                {(refData.expertiseOptions || []).map((o) => {
                  const selected = form.watch("expertiseOffered") || [];
                  return (
                    <label key={o.code} className="wlth-check">
                      <input
                        type="checkbox"
                        checked={selected.includes(o.code)}
                        onChange={() => toggleMulti("expertiseOffered", o.code, 5)}
                      />
                      <span>{o.label}</span>
                    </label>
                  );
                })}
              </div>
              <div className="wlth-field">
                <label htmlFor="ex">Expertise context (optional)</label>
                <textarea id="ex" rows={2} {...form.register("expertiseContext")} />
              </div>

              <div className="wlth-field">
                <label htmlFor="ct">Connection type</label>
                <select id="ct" {...form.register("connectionType")}>
                  <option value="">Select</option>
                  {refData.connectionTypes.map((i) => (
                    <option key={i.code} value={i.code}>
                      {i.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="wlth-field">
                <label htmlFor="td">Topics to discuss</label>
                <textarea id="td" rows={2} {...form.register("topicsToDiscuss")} />
              </div>

              <div className="wlth-actions">
                <button type="submit" className="wlth-btn-primary" disabled={saving}>
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
