import { useCallback, useEffect, useMemo, useState } from "react";

type Stage =
  | "ACCOUNT"
  | "LOCATION"
  | "BUSINESS"
  | "PAYMENT"
  | "SUCCESS"
  | "GOAL"
  | "HELP_WANTED"
  | "EXPERTISE"
  | "CONNECTION"
  | "DONE";

const STAGE_LABELS: Record<Stage, string> = {
  ACCOUNT: "Account",
  LOCATION: "Location",
  BUSINESS: "Business",
  PAYMENT: "Payment",
  SUCCESS: "You’re in",
  GOAL: "90-day goal",
  HELP_WANTED: "Help wanted",
  EXPERTISE: "Expertise",
  CONNECTION: "Connection",
  DONE: "Done",
};

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
      return JSON.parse(stored);
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
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string>),
  };
  if (opts.token) headers["X-Memberstack-Token"] = opts.token;
  const res = await fetch(`${base}${path}`, { ...opts, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.message || res.statusText || "Request failed");
  }
  return json;
}

function getMsToken(): string | null {
  try {
    // Memberstack DOM may expose token via cookie/local storage depending on version
    const w = window as unknown as {
      $memberstackDom?: {
        getMemberCookie?: () => Promise<{ accessToken?: string } | null>;
      };
    };
    return null; // filled async
  } catch {
    return null;
  }
}

async function resolveMemberstackToken(): Promise<string | null> {
  const w = window as unknown as {
    $memberstackDom?: {
      getMemberCookie?: () => Promise<{ accessToken?: string; token?: string } | null>;
      getCurrentMember?: () => Promise<{ data?: { auth?: { accessToken?: string } } }>;
    };
  };
  if (!w.$memberstackDom) return null;
  try {
    if (w.$memberstackDom.getMemberCookie) {
      const c = await w.$memberstackDom.getMemberCookie();
      if (c?.accessToken) return c.accessToken;
      if (c?.token) return c.token;
    }
    if (w.$memberstackDom.getCurrentMember) {
      const m = await w.$memberstackDom.getCurrentMember();
      const t = m?.data?.auth?.accessToken;
      if (t) return t;
    }
  } catch {
    return null;
  }
  return null;
}

export function SignupApp(props: { apiBase: string }) {
  const [stage, setStage] = useState<Stage>("ACCOUNT");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refData, setRefData] = useState<RefData | null>(null);
  const [config, setConfig] = useState<{
    membershipPriceId: string;
    homeUrl: string;
    flags: { signupEnabled: boolean };
  } | null>(null);
  const [token, setToken] = useState<string | null>(null);

  const [account, setAccount] = useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
  });
  const [location, setLocation] = useState({
    countryCode: "GB",
    cityCode: "",
    availability: [] as string[],
  });
  const [business, setBusiness] = useState({
    primaryIndustry: "",
    businessStage: "",
    annualRevenue: "",
    businessDescription: "",
  });
  const [goal, setGoal] = useState("");
  const [helpWanted, setHelpWanted] = useState<string[]>([]);
  const [helpCtx, setHelpCtx] = useState("");
  const [expertise, setExpertise] = useState<string[]>([]);
  const [expCtx, setExpCtx] = useState("");
  const [connection, setConnection] = useState("");

  const attribution = useMemo(() => captureAttribution(), []);

  useEffect(() => {
    void (async () => {
      try {
        const [cfg, ref] = await Promise.all([
          api(props.apiBase, "/api/forms/config"),
          api(props.apiBase, "/api/reference-data/onboarding"),
        ]);
        setConfig(cfg);
        setRefData(ref);
        const t = await resolveMemberstackToken();
        if (t) {
          setToken(t);
          const status = await api(props.apiBase, "/api/onboarding/status", { token: t });
          if (status.exists && status.resumeStage) {
            const map: Record<string, Stage> = {
              LOCATION: "LOCATION",
              BUSINESS: "BUSINESS",
              PAYMENT_PENDING: "PAYMENT",
              PAYMENT_CONFIRMED: "SUCCESS",
              GOAL: "GOAL",
              HELP_WANTED: "HELP_WANTED",
              EXPERTISE: "EXPERTISE",
              CONNECTION: "CONNECTION",
              COMPLETE: "DONE",
            };
            setStage(map[status.resumeStage] || "LOCATION");
          }
        }
        const params = new URLSearchParams(window.location.search);
        if (params.get("payment") === "success") setStage("SUCCESS");
        if (params.get("payment") === "cancel") setStage("PAYMENT");
        void api(props.apiBase, "/api/onboarding/analytics", {
          method: "POST",
          body: JSON.stringify({
            eventType: "FORM_VIEWED",
            sessionId: sessionStorage.getItem("wlth_session") || undefined,
            utm_source: attribution.utm_source,
            utm_medium: attribution.utm_medium,
            utm_campaign: attribution.utm_campaign,
          }),
        }).catch(() => undefined);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load form");
      }
    })();
  }, [props.apiBase, attribution]);

  const cities = useMemo(
    () =>
      (refData?.cities || []).filter((c) => c.countryCode === location.countryCode),
    [refData, location.countryCode]
  );

  const saveStep = useCallback(
    async (s: string, data: unknown) => {
      if (!token) return;
      await api(props.apiBase, "/api/onboarding/step", {
        method: "PATCH",
        token,
        body: JSON.stringify({ stage: s, data }),
      });
    },
    [props.apiBase, token]
  );

  const onAccountNext = async () => {
    setError(null);
    setLoading(true);
    try {
      const w = window as unknown as {
        $memberstackDom?: {
          signupMemberEmailPassword?: (p: {
            email: string;
            password: string;
            customFields?: Record<string, string>;
          }) => Promise<unknown>;
          loginMemberEmailPassword?: (p: {
            email: string;
            password: string;
          }) => Promise<unknown>;
        };
      };
      if (!w.$memberstackDom?.signupMemberEmailPassword) {
        throw new Error(
          "Memberstack is not loaded. Add the Memberstack script on this Webflow page."
        );
      }
      try {
        await w.$memberstackDom.signupMemberEmailPassword({
          email: account.email.trim().toLowerCase(),
          password: account.password,
          customFields: {
            "first-name": account.firstName.trim(),
            "last-name": account.lastName.trim(),
          },
        });
      } catch {
        await w.$memberstackDom.loginMemberEmailPassword?.({
          email: account.email.trim().toLowerCase(),
          password: account.password,
        });
      }
      const t = await resolveMemberstackToken();
      if (!t) throw new Error("Signed in but could not read Memberstack token");
      setToken(t);
      await api(props.apiBase, "/api/onboarding/bootstrap", {
        method: "POST",
        token: t,
        body: JSON.stringify({
          firstName: account.firstName.trim(),
          lastName: account.lastName.trim(),
          email: account.email.trim().toLowerCase(),
          attribution,
        }),
      });
      setStage("LOCATION");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Account step failed");
    } finally {
      setLoading(false);
    }
  };

  const onLocationNext = async () => {
    setError(null);
    setLoading(true);
    try {
      await saveStep("LOCATION", location);
      setStage("BUSINESS");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Location save failed");
    } finally {
      setLoading(false);
    }
  };

  const onBusinessNext = async () => {
    setError(null);
    setLoading(true);
    try {
      await saveStep("BUSINESS", business);
      await saveStep("PAYMENT_PENDING", {});
      setStage("PAYMENT");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Business save failed");
    } finally {
      setLoading(false);
    }
  };

  const startCheckout = async () => {
    setError(null);
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
      return;
    }
    if (!w.$memberstackDom?.purchasePlansWithCheckout) {
      setError("Memberstack checkout is unavailable on this page.");
      return;
    }
    const base = window.location.origin + window.location.pathname;
    await api(props.apiBase, "/api/onboarding/analytics", {
      method: "POST",
      body: JSON.stringify({ eventType: "CHECKOUT_STARTED", memberstackId: undefined }),
    }).catch(() => undefined);
    await w.$memberstackDom.purchasePlansWithCheckout({
      priceId,
      successUrl: `${base}?payment=success`,
      cancelUrl: `${base}?payment=cancel`,
    });
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

  const toggle = (list: string[], code: string, max: number) => {
    if (list.includes(code)) return list.filter((c) => c !== code);
    if (list.length >= max) return list;
    return [...list, code];
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

  return (
    <div className="wlth-widget">
      <div className="wlth-card">
        <div className="wlth-steps" aria-label="Progress">
          {(
            ["ACCOUNT", "LOCATION", "BUSINESS", "PAYMENT", "GOAL"] as Stage[]
          ).map((s) => (
            <span
              key={s}
              className={`wlth-step-dot ${stage === s ? "is-active" : ""}`}
            >
              {STAGE_LABELS[s]}
            </span>
          ))}
        </div>

        {error && <div className="wlth-banner-error">{error}</div>}

        {stage === "ACCOUNT" && (
          <>
            <h1>Join WLTH WLKS</h1>
            <p>Create your account to continue.</p>
            <label htmlFor="fn">First name</label>
            <input
              id="fn"
              value={account.firstName}
              onChange={(e) => setAccount({ ...account, firstName: e.target.value })}
              autoComplete="given-name"
            />
            <label htmlFor="ln">Last name</label>
            <input
              id="ln"
              value={account.lastName}
              onChange={(e) => setAccount({ ...account, lastName: e.target.value })}
              autoComplete="family-name"
            />
            <label htmlFor="em">Email</label>
            <input
              id="em"
              type="email"
              value={account.email}
              onChange={(e) => setAccount({ ...account, email: e.target.value })}
              autoComplete="email"
            />
            <label htmlFor="pw">Password</label>
            <input
              id="pw"
              type="password"
              value={account.password}
              onChange={(e) => setAccount({ ...account, password: e.target.value })}
              autoComplete="new-password"
            />
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                disabled={loading}
                onClick={() => void onAccountNext()}
              >
                Continue
              </button>
            </div>
          </>
        )}

        {stage === "LOCATION" && (
          <>
            <h2>Where are you based?</h2>
            <label htmlFor="country">Country</label>
            <select
              id="country"
              value={location.countryCode}
              onChange={(e) =>
                setLocation({ ...location, countryCode: e.target.value, cityCode: "" })
              }
            >
              {refData.countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
            <label htmlFor="city">City</label>
            <select
              id="city"
              value={location.cityCode}
              onChange={(e) => setLocation({ ...location, cityCode: e.target.value })}
            >
              <option value="">Select city</option>
              {cities.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="wlth-muted">General availability (select all that apply)</p>
            <div className="wlth-check-grid">
              {refData.availabilityOptions.map((o) => (
                <label key={o.code} className="wlth-check">
                  <input
                    type="checkbox"
                    checked={location.availability.includes(o.code)}
                    onChange={() =>
                      setLocation({
                        ...location,
                        availability: toggle(location.availability, o.code, 21),
                      })
                    }
                  />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                disabled={loading || !location.cityCode || !location.availability.length}
                onClick={() => void onLocationNext()}
              >
                Continue
              </button>
            </div>
          </>
        )}

        {stage === "BUSINESS" && (
          <>
            <h2>About your business</h2>
            <label htmlFor="ind">Primary industry</label>
            <select
              id="ind"
              value={business.primaryIndustry}
              onChange={(e) =>
                setBusiness({ ...business, primaryIndustry: e.target.value })
              }
            >
              <option value="">Select</option>
              {refData.industries.map((i) => (
                <option key={i.code} value={i.code}>
                  {i.label}
                </option>
              ))}
            </select>
            <label htmlFor="stage">Business stage</label>
            <select
              id="stage"
              value={business.businessStage}
              onChange={(e) =>
                setBusiness({ ...business, businessStage: e.target.value })
              }
            >
              <option value="">Select</option>
              {refData.businessStages.map((i) => (
                <option key={i.code} value={i.code}>
                  {i.label}
                </option>
              ))}
            </select>
            <label htmlFor="rev">Approximate annual revenue</label>
            <select
              id="rev"
              value={business.annualRevenue}
              onChange={(e) =>
                setBusiness({ ...business, annualRevenue: e.target.value })
              }
            >
              <option value="">Select</option>
              {refData.revenueBrackets.map((i) => (
                <option key={i.code} value={i.code}>
                  {i.label}
                </option>
              ))}
            </select>
            <label htmlFor="desc">What does your business do, and who does it help?</label>
            <textarea
              id="desc"
              rows={4}
              value={business.businessDescription}
              onChange={(e) =>
                setBusiness({ ...business, businessDescription: e.target.value })
              }
            />
            <p className="wlth-muted">40–400 characters</p>
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                disabled={loading}
                onClick={() => void onBusinessNext()}
              >
                Continue to payment
              </button>
            </div>
          </>
        )}

        {stage === "PAYMENT" && (
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

        {stage === "SUCCESS" && (
          <>
            <h1>You’re in!</h1>
            <p>Complete your profile to get better matches (optional for now — matching is unchanged).</p>
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                onClick={() => setStage("GOAL")}
              >
                Complete your profile to get better matches
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

        {stage === "GOAL" && (
          <>
            <h2>90-day goal</h2>
            <label htmlFor="goal">
              What is your most important business goal for the next 90 days?
            </label>
            <textarea
              id="goal"
              rows={4}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                disabled={loading || goal.trim().length < 30}
                onClick={() => {
                  void (async () => {
                    await saveStep("GOAL", { ninetyDayGoal: goal.trim() });
                    setStage("HELP_WANTED");
                  })().catch((e) =>
                    setError(e instanceof Error ? e.message : "Save failed")
                  );
                }}
              >
                Continue
              </button>
            </div>
          </>
        )}

        {stage === "HELP_WANTED" && (
          <>
            <h2>Help wanted</h2>
            <p className="wlth-muted">Select up to three</p>
            <div className="wlth-check-grid">
              {refData.helpWantedOptions.map((o) => (
                <label key={o.code} className="wlth-check">
                  <input
                    type="checkbox"
                    checked={helpWanted.includes(o.code)}
                    onChange={() => setHelpWanted(toggle(helpWanted, o.code, 3))}
                  />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
            <label htmlFor="hc">Optional context</label>
            <textarea
              id="hc"
              rows={2}
              value={helpCtx}
              onChange={(e) => setHelpCtx(e.target.value)}
            />
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                onClick={() => {
                  void (async () => {
                    await saveStep("HELP_WANTED", {
                      helpWanted,
                      helpWantedContext: helpCtx,
                    });
                    setStage("EXPERTISE");
                  })().catch((e) =>
                    setError(e instanceof Error ? e.message : "Save failed")
                  );
                }}
              >
                Continue
              </button>
            </div>
          </>
        )}

        {stage === "EXPERTISE" && (
          <>
            <h2>Expertise offered</h2>
            <p className="wlth-muted">Select up to five</p>
            <div className="wlth-check-grid">
              {refData.expertiseOptions.map((o) => (
                <label key={o.code} className="wlth-check">
                  <input
                    type="checkbox"
                    checked={expertise.includes(o.code)}
                    onChange={() => setExpertise(toggle(expertise, o.code, 5))}
                  />
                  <span>{o.label}</span>
                </label>
              ))}
            </div>
            <label htmlFor="ec">Optional context</label>
            <textarea
              id="ec"
              rows={2}
              value={expCtx}
              onChange={(e) => setExpCtx(e.target.value)}
            />
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                onClick={() => {
                  void (async () => {
                    await saveStep("EXPERTISE", {
                      expertiseOffered: expertise,
                      expertiseContext: expCtx,
                    });
                    setStage("CONNECTION");
                  })().catch((e) =>
                    setError(e instanceof Error ? e.message : "Save failed")
                  );
                }}
              >
                Continue
              </button>
            </div>
          </>
        )}

        {stage === "CONNECTION" && (
          <>
            <h2>Connection preference</h2>
            <label htmlFor="ct">Which kind of connection would help you most?</label>
            <select
              id="ct"
              value={connection}
              onChange={(e) => setConnection(e.target.value)}
            >
              <option value="">Select</option>
              {refData.connectionTypes.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
            <div className="wlth-actions">
              <button
                type="button"
                className="wlth-btn-primary"
                disabled={!connection || loading}
                onClick={() => {
                  void (async () => {
                    await saveStep("CONNECTION", { connectionType: connection });
                    await finish();
                  })().catch((e) =>
                    setError(e instanceof Error ? e.message : "Save failed")
                  );
                }}
              >
                Finish
              </button>
            </div>
          </>
        )}

        {stage === "DONE" && (
          <>
            <h1>Welcome</h1>
            <p>Redirecting you home…</p>
          </>
        )}
      </div>
    </div>
  );
}

void getMsToken;
