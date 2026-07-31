import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { widgetApi } from "../../shared/api";
import {
  logMemberstackDiagnostics,
  tryResolveSessionAccessToken,
} from "../../shared/memberstack-auth";

const profileSchema = z.object({
  firstName: z.string().trim().min(1, "Required").max(80),
  lastName: z.string().trim().min(1, "Required").max(80),
  email: z
    .string()
    .trim()
    .email()
    .transform((e) => e.toLowerCase()),
  phone: z.string().trim().max(40).optional(),
  businessName: z.string().trim().max(120).optional(),
  businessWebsite: z.string().trim().max(500).optional(),
  countryCode: z.string().min(2),
  cityCode: z.string().optional(),
  primaryIndustry: z.string().optional(),
  businessStage: z.string().optional(),
  annualRevenue: z.string().optional(),
  businessDescription: z.string().trim().max(400).optional(),
  ninetyDayGoal: z.string().trim().max(300).optional(),
  connectionType: z.string().optional(),
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
      businessName: "",
      businessWebsite: "",
      countryCode: "GB",
      cityCode: "",
      primaryIndustry: "",
      businessStage: "",
      annualRevenue: "",
      businessDescription: "",
      ninetyDayGoal: "",
      connectionType: "",
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
        setRefData(ref as typeof refData extends infer R ? Exclude<R, null> : never);
        const p = (profileRes.profile || {}) as Record<string, string>;
        form.reset({
          firstName: p.firstName || "",
          lastName: p.lastName || "",
          email: p.email || "",
          phone: p.phone || "",
          businessName: p.businessName || "",
          businessWebsite: p.businessWebsite || "",
          countryCode: p.countryCode || "GB",
          cityCode: p.cityCode || "",
          primaryIndustry: p.primaryIndustry || "",
          businessStage: p.businessStage || "",
          annualRevenue: p.annualRevenue || "",
          businessDescription: p.businessDescription || "",
          ninetyDayGoal: p.ninetyDayGoal || "",
          connectionType: p.connectionType || "",
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
          businessName: values.businessName,
          businessWebsite: values.businessWebsite || undefined,
          countryCode: values.countryCode,
          cityCode: values.cityCode || undefined,
          primaryIndustry: values.primaryIndustry || undefined,
          businessStage: values.businessStage || undefined,
          annualRevenue: values.annualRevenue || undefined,
          businessDescription: values.businessDescription || undefined,
          ninetyDayGoal: values.ninetyDayGoal || undefined,
          connectionType: values.connectionType || undefined,
        }),
      });
      setOk("Saved");
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

  if (loading) {
    return (
      <div className="wlth-widget">
        <div className="wlth-card">
          <p>Loading your details…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="wlth-widget">
      <div className="wlth-card">
        <h1>Update details</h1>
        <p>Keep your WLTH WLKS profile up to date.</p>
        {error && (
          <div className="wlth-banner-error" role="alert">
            {error}
          </div>
        )}
        {ok && <div className="wlth-banner-success">{ok}</div>}

        {!token && <p>Log in to continue.</p>}

        {token && refData && (
          <form onSubmit={onSave} noValidate>
            <h2>Personal</h2>
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
            <div className="wlth-field">
              <label htmlFor="em">Email</label>
              <input id="em" type="email" {...form.register("email")} />
              <FieldError message={form.formState.errors.email?.message} />
            </div>
            <div className="wlth-field">
              <label htmlFor="ph">Phone</label>
              <input id="ph" {...form.register("phone")} />
            </div>

            <h2>Location</h2>
            <div className="wlth-field">
              <label htmlFor="co">Country</label>
              <select
                id="co"
                {...form.register("countryCode", {
                  onChange: () => form.setValue("cityCode", ""),
                })}
              >
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

            <h2>Business</h2>
            <div className="wlth-field">
              <label htmlFor="bn">Business name</label>
              <input id="bn" {...form.register("businessName")} />
            </div>
            <div className="wlth-field">
              <label htmlFor="bw">Website</label>
              <input id="bw" {...form.register("businessWebsite")} />
            </div>
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
              <label htmlFor="bd">Description</label>
              <textarea id="bd" rows={3} {...form.register("businessDescription")} />
            </div>

            <h2>Profile preferences</h2>
            <div className="wlth-field">
              <label htmlFor="g">90-day goal</label>
              <textarea id="g" rows={3} {...form.register("ninetyDayGoal")} />
            </div>
            <div className="wlth-field">
              <label htmlFor="ct">Connection type</label>
              <select id="ct" {...form.register("connectionType")}>
                <option value="">Select</option>
                {refData.connectionTypes.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <h2>Account & billing</h2>
            {billing && (
              <p className="wlth-muted">
                Membership: {billing.membership || "—"} · Payment: {billing.payment || "—"}
                <br />
                Service access until: {billing.serviceAccessUntil || "—"}
                <br />
                {billing.cancelAtPeriodEnd
                  ? `Cancellation scheduled${
                      billing.cancellationEffectiveAt
                        ? ` (effective ${billing.cancellationEffectiveAt})`
                        : ""
                    }`
                  : "No cancellation scheduled"}
              </p>
            )}

            <div className="wlth-actions">
              <button type="submit" className="wlth-btn-primary" disabled={saving}>
                {saving ? "Saving…" : "Save changes"}
              </button>
              <button
                type="button"
                className="wlth-btn-secondary"
                onClick={() => void openPortal()}
              >
                Manage membership
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
