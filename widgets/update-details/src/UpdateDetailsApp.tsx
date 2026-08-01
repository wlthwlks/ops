import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { widgetApi } from "../../shared/api";
import {
  logMemberstackDiagnostics,
  tryResolveSessionAccessToken,
} from "../../shared/memberstack-auth";
import { WalkingLoader } from "../../shared/WalkingLoader";

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
  helpWantedContext: z.string().trim().max(400).optional(),
  expertiseContext: z.string().trim().max(400).optional(),
  connectionType: z.string().optional(),
  topicsToDiscuss: z.string().trim().max(1000).optional(),
});

type ProfileForm = z.infer<typeof profileSchema>;

async function api(base: string, path: string, opts: RequestInit & { token?: string } = {}) {
  return widgetApi(base, path, opts) as Promise<Record<string, unknown>>;
}

function FieldError({ message }: { message?: string }) {
  return <div className="wlth-error">{message || "\u00a0"}</div>;
}

export function UpdateDetailsApp(props: { apiBase: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refData, setRefData] = useState<{
    countries: Array<{ code: string; label: string }>;
    cities: Array<{ code: string; label: string; countryCode: string }>;
    industries: Array<{ code: string; label: string }>;
    businessStages: Array<{ code: string; label: string }>;
    revenueBrackets: Array<{ code: string; label: string }>;
    availabilityOptions: Array<{ code: string; label: string }>;
    connectionTypes: Array<{ code: string; label: string }>;
  } | null>(null);
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
      helpWantedContext: "",
      expertiseContext: "",
      connectionType: "",
      topicsToDiscuss: "",
    },
    mode: "onBlur",
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
        const [ref, profileRes, bill] = await Promise.all([
          api(props.apiBase, "/api/reference-data/onboarding"),
          api(props.apiBase, "/api/member/profile", { token: t }),
          api(props.apiBase, "/api/member/billing-status", { token: t }),
        ]);
        const rd = ref as typeof refData extends infer R ? Exclude<R, null> : never;
        setRefData(rd);
        const p = (profileRes.profile || {}) as Record<string, unknown>;
        form.reset({
          firstName: String(p.firstName || ""),
          lastName: String(p.lastName || ""),
          email: String(p.email || ""),
          phone: String(p.phone || ""),
          countryCode:
            String(p.countryCode || "") ||
            (rd.countries?.[0]?.code ?? ""),
          cityCode: String(p.cityCode || ""),
          availability: Array.isArray(p.availability)
            ? (p.availability as string[])
            : [],
          primaryIndustry: String(p.primaryIndustry || ""),
          businessStage: String(p.businessStage || ""),
          annualRevenue: String(p.annualRevenue || ""),
          businessDescription: String(p.businessDescription || ""),
          ninetyDayGoal: String(p.ninetyDayGoal || ""),
          helpWantedContext: String(p.helpWantedContext || ""),
          expertiseContext: String(p.expertiseContext || ""),
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
          helpWantedContext: values.helpWantedContext || undefined,
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

  const toggleAvail = (code: string) => {
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
  };

  if (loading || saving) {
    return (
      <div className="wlth-widget">
        <div className="wlth-card wlth-overlay-load">
          <WalkingLoader
            message={
              saving ? "Updating your WLTH WLKS profile…" : "Loading your profile…"
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="wlth-widget">
      <div className="wlth-card">
        <h1>Update details</h1>
        <p>Keep your WLTH WLKS profile current so introductions stay relevant.</p>
        {error && (
          <div className="wlth-banner-error" role="alert">
            {error}
          </div>
        )}
        {ok && <div className="wlth-banner-success">{ok}</div>}

        {!token && <p>Log in to continue.</p>}

        {token && refData && (
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
                      onChange={() => toggleAvail(o.code)}
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
            <div className="wlth-field">
              <label htmlFor="hw">Help wanted context</label>
              <textarea id="hw" rows={2} {...form.register("helpWantedContext")} />
            </div>
            <div className="wlth-field">
              <label htmlFor="ex">Expertise context</label>
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
              <button type="button" className="wlth-btn-secondary" onClick={() => void openPortal()}>
                Manage billing (Stripe)
              </button>
            </div>
          </form>
        )}

        {billing && (
          <p className="wlth-muted" style={{ marginTop: 20 }}>
            Membership: {billing.membership || "—"} · Payment: {billing.payment || "—"}
            {billing.serviceAccessUntil
              ? ` · Access until ${billing.serviceAccessUntil.slice(0, 10)}`
              : ""}
          </p>
        )}
      </div>
    </div>
  );
}
