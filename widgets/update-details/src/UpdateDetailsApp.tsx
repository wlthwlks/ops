import { useEffect, useMemo, useState } from "react";

async function resolveToken(): Promise<string | null> {
  const w = window as unknown as {
    $memberstackDom?: {
      getMemberCookie?: () => Promise<{ accessToken?: string; token?: string } | null>;
    };
  };
  try {
    const c = await w.$memberstackDom?.getMemberCookie?.();
    return c?.accessToken || c?.token || null;
  } catch {
    return null;
  }
}

async function api(base: string, path: string, opts: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string>),
  };
  if (opts.token) headers["X-Memberstack-Token"] = opts.token;
  const res = await fetch(`${base}${path}`, { ...opts, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || res.statusText);
  return json;
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
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    businessName: "",
    businessWebsite: "",
    countryCode: "GB",
    cityCode: "",
    availability: [] as string[],
    primaryIndustry: "",
    businessStage: "",
    annualRevenue: "",
    businessDescription: "",
    ninetyDayGoal: "",
    connectionType: "",
  });
  const [billing, setBilling] = useState<{
    membership: string;
    payment: string;
    serviceAccessUntil: string;
    cancelAtPeriodEnd: boolean;
    cancellationEffectiveAt: string;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const t = await resolveToken();
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
        setRefData(ref);
        const p = profileRes.profile;
        setForm({
          firstName: p.firstName || "",
          lastName: p.lastName || "",
          email: p.email || "",
          phone: p.phone || "",
          businessName: p.businessName || "",
          businessWebsite: p.businessWebsite || "",
          countryCode: p.countryCode || "GB",
          cityCode: p.cityCode || "",
          availability: p.availability || [],
          primaryIndustry: p.primaryIndustry || "",
          businessStage: p.businessStage || "",
          annualRevenue: p.annualRevenue || "",
          businessDescription: p.businessDescription || "",
          ninetyDayGoal: p.ninetyDayGoal || "",
          connectionType: p.connectionType || "",
        });
        setBilling(bill.billing);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load profile");
      } finally {
        setLoading(false);
      }
    })();
  }, [props.apiBase]);

  const cities = useMemo(
    () =>
      (refData?.cities || []).filter((c) => c.countryCode === form.countryCode),
    [refData, form.countryCode]
  );

  const save = async () => {
    if (!token) return;
    setSaving(true);
    setError(null);
    setOk(null);
    try {
      if (form.email) {
        await api(props.apiBase, "/api/member/email", {
          method: "POST",
          token,
          body: JSON.stringify({ email: form.email }),
        });
      }
      await api(props.apiBase, "/api/member/profile", {
        method: "PATCH",
        token,
        body: JSON.stringify({
          firstName: form.firstName,
          lastName: form.lastName,
          phone: form.phone,
          businessName: form.businessName,
          businessWebsite: form.businessWebsite || undefined,
          countryCode: form.countryCode,
          cityCode: form.cityCode || undefined,
          availability: form.availability,
          primaryIndustry: form.primaryIndustry || undefined,
          businessStage: form.businessStage || undefined,
          annualRevenue: form.annualRevenue || undefined,
          businessDescription: form.businessDescription || undefined,
          ninetyDayGoal: form.ninetyDayGoal || undefined,
          connectionType: form.connectionType || undefined,
        }),
      });
      setOk("Saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

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
        {error && <div className="wlth-banner-error">{error}</div>}
        {ok && <div className="wlth-banner-success">{ok}</div>}

        {!token && <p>Log in to continue.</p>}

        {token && refData && (
          <>
            <h2>Personal</h2>
            <label>First name</label>
            <input
              value={form.firstName}
              onChange={(e) => setForm({ ...form, firstName: e.target.value })}
            />
            <label>Last name</label>
            <input
              value={form.lastName}
              onChange={(e) => setForm({ ...form, lastName: e.target.value })}
            />
            <label>Email</label>
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <label>Phone</label>
            <input
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />

            <h2>Location</h2>
            <label>Country</label>
            <select
              value={form.countryCode}
              onChange={(e) =>
                setForm({ ...form, countryCode: e.target.value, cityCode: "" })
              }
            >
              {refData.countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
            <label>City</label>
            <select
              value={form.cityCode}
              onChange={(e) => setForm({ ...form, cityCode: e.target.value })}
            >
              <option value="">Select</option>
              {cities.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>

            <h2>Business</h2>
            <label>Business name</label>
            <input
              value={form.businessName}
              onChange={(e) => setForm({ ...form, businessName: e.target.value })}
            />
            <label>Website</label>
            <input
              value={form.businessWebsite}
              onChange={(e) => setForm({ ...form, businessWebsite: e.target.value })}
            />
            <label>Industry</label>
            <select
              value={form.primaryIndustry}
              onChange={(e) => setForm({ ...form, primaryIndustry: e.target.value })}
            >
              <option value="">Select</option>
              {refData.industries.map((i) => (
                <option key={i.code} value={i.code}>
                  {i.label}
                </option>
              ))}
            </select>
            <label>Stage</label>
            <select
              value={form.businessStage}
              onChange={(e) => setForm({ ...form, businessStage: e.target.value })}
            >
              <option value="">Select</option>
              {refData.businessStages.map((i) => (
                <option key={i.code} value={i.code}>
                  {i.label}
                </option>
              ))}
            </select>
            <label>Revenue</label>
            <select
              value={form.annualRevenue}
              onChange={(e) => setForm({ ...form, annualRevenue: e.target.value })}
            >
              <option value="">Select</option>
              {refData.revenueBrackets.map((i) => (
                <option key={i.code} value={i.code}>
                  {i.label}
                </option>
              ))}
            </select>
            <label>Description</label>
            <textarea
              rows={3}
              value={form.businessDescription}
              onChange={(e) =>
                setForm({ ...form, businessDescription: e.target.value })
              }
            />

            <h2>Profile preferences</h2>
            <label>90-day goal</label>
            <textarea
              rows={3}
              value={form.ninetyDayGoal}
              onChange={(e) => setForm({ ...form, ninetyDayGoal: e.target.value })}
            />
            <label>Connection type</label>
            <select
              value={form.connectionType}
              onChange={(e) => setForm({ ...form, connectionType: e.target.value })}
            >
              <option value="">Select</option>
              {refData.connectionTypes.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>

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
              <button
                type="button"
                className="wlth-btn-primary"
                disabled={saving}
                onClick={() => void save()}
              >
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
          </>
        )}
      </div>
    </div>
  );
}
