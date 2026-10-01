# Webflow embed

## Signup (`/apply`)

```html
<div id="wlth-signup-root" data-api-base="https://ops.wlthwlks.com"></div>
<link rel="stylesheet" href="https://ops.wlthwlks.com/widgets/signup/v1/signup.css" />
<script src="https://ops.wlthwlks.com/widgets/signup/v1/signup.js" defer></script>
```

Also load Memberstack DOM script with your public key on the page.

### Existing-member redirect gate (required)

**Do not** redirect every logged-in member away from `/apply`. New members returning from Stripe are already logged in and must stay on `/apply` to finish matching.

Use the shared helper exposed by the signup bundle as `window.WlthSignupFlow` (see “Webflow page code” below).

| Visitor | Behaviour |
|---|---|
| Logged out | Stay on `/apply` |
| Logged in + active signup-flow marker for **this** member id | Stay on `/apply` (includes Stripe return) |
| Logged in + no marker / expired / different member | `location.replace("/update-details")` |

- Marker key: `localStorage.wlth_signup_flow_v1` → `{ v, memberId, startedAt }` only  
- TTL: 8 hours  
- Set when the signup widget creates/binds the Memberstack account  
- Cleared only after payment is verified **and** the final Matching step is saved (`onboarding/complete`)  
- Never cleared when opening Stripe or immediately after payment  

## Update details

```html
<div id="wlth-update-details-root" data-api-base="https://ops.wlthwlks.com"></div>
<link rel="stylesheet" href="https://ops.wlthwlks.com/widgets/update-details/v1/update-details.css" />
<script src="https://ops.wlthwlks.com/widgets/update-details/v1/update-details.js" defer></script>
```

## Getting Started

```html
<div id="wlth-getting-started-root" data-api-base="https://ops.wlthwlks.com" data-directory-url="https://women.wlthwlks.com/member-directory"></div>
<link rel="stylesheet" href="https://ops.wlthwlks.com/widgets/getting-started/v1/getting-started.css" />
<script src="https://ops.wlthwlks.com/widgets/getting-started/v1/getting-started.js" defer></script>
```

Memberstack DOM script must be on the page (same as signup/update-details).

| Attribute | Purpose | Required? |
|---|---|---|
| `data-api-base` | Base URL of the ops API | Yes (widgets fetch profile + directory status) |
| `data-directory-url` | URL for Member Directory CTA button | Optional (defaults to `#`) |
| `data-allow-anonymous` | Set to `true` to skip Memberstack gate (dev only) | Optional (defaults `false`) |

Behaviour:
- Resolves Memberstack session via shared `tryResolveSessionAccessToken`
- Logged out → "Log in to view Getting Started" message
- Authed → full Getting Started page (may show the Member Directory join popup)

## Member Directory

```html
<div id="wlth-member-directory-root" data-api-base="https://ops.wlthwlks.com" data-getting-started-url="/getting-started" data-update-details-url="/update-details"></div>
<link rel="stylesheet" href="https://ops.wlthwlks.com/widgets/member-directory/v1/member-directory.css" />
<script src="https://ops.wlthwlks.com/widgets/member-directory/v1/member-directory.js" defer></script>
```

Memberstack DOM script must be on the page (same as signup/update-details).

| Attribute | Purpose | Required? |
|---|---|---|
| `data-api-base` | Base URL of the ops API | Yes |
| `data-getting-started-url` | Destination for the "Back to Getting Started" button on the join gate | Optional (defaults `/getting-started`) |
| `data-update-details-url` | Destination for the "Reactivate membership" button shown to non-active members | Optional (defaults `/update-details`) |
| `data-allow-anonymous` | Set to `true` to skip Memberstack gate (dev only) | Optional (defaults `false`) |

Behaviour:
- Members-only: logged-out visitors see "Members only".
- Only members with an **active membership** (Membership `Active` + Payment `Paid`) who are also **in the directory** (status `Active`) can browse it.
- Non-active members see a "Reactivate your membership" screen linking to Update Details.
- Active members not yet opted in see the "Unlock the Member Directory" join gate (checkbox + missing fields), and the directory reloads once they join.

## Staging

1. Embed only on Webflow staging / password pages first.
2. Point `data-api-base` at a preview Vercel deployment.
3. Keep production Tally until validated.
