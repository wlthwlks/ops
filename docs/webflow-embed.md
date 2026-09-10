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
<div id="wlth-getting-started-root" data-directory-url="https://women.wlthwlks.com/member-directory"></div>
<link rel="stylesheet" href="https://ops.wlthwlks.com/widgets/getting-started/v1/getting-started.css" />
<script src="https://ops.wlthwlks.com/widgets/getting-started/v1/getting-started.js" defer></script>
```

Memberstack DOM script must be on the page (same as signup/update-details).

| Attribute | Purpose | Required? |
|---|---|---|
| `data-directory-url` | URL for Member Directory CTA button | Optional (defaults to `#`) |
| `data-allow-anonymous` | Set to `true` to skip Memberstack gate (dev only) | Optional (defaults `false`) |

Behaviour:
- Resolves Memberstack session via shared `tryResolveSessionAccessToken`
- Logged out → "Log in to view Getting Started" message
- Authed → full Getting Started page

## Events

```html
<div id="wlth-events-root"></div>
<link rel="stylesheet" href="https://ops.wlthwlks.com/widgets/events/v1/events.css" />
<script src="https://ops.wlthwlks.com/widgets/events/v1/events.js" defer></script>
```

| Attribute | Purpose | Required? |
|---|---|---|
| `data-embed-src` | Full Sweatpals community events embed script URL (overrides the default staging embed) | Optional |

Behaviour:
- Renders the WLTH WLKS "Events" header (eyebrow, title, description)
- Injects the Sweatpals embed script into a container below the header; Sweatpals mounts its events UI (shadow root or iframe) next to that script tag
- Shows a loading state until the embed mounts, and a friendly error message if the script fails to load

## Staging

1. Embed only on Webflow staging / password pages first.
2. Point `data-api-base` at a preview Vercel deployment.
3. Keep production Tally until validated.
