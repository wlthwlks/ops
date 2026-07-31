# Signup widget

Build: `npm run widgets:build:signup` → `public/widgets/signup/v1/`.

UI stack: **@stepperize/react** (linear steps) + **react-hook-form** + **Zod** (`widgets/shared/widget-schemas.ts`) + scoped `.wlth-widget` CSS.

Stages: Account → Location → Business → Payment (Memberstack checkout) → Success → Goal → Help → Expertise → Connection → home.

Autosave via `PATCH /api/onboarding/step` when Memberstack token is present.

### Authentication (account step)

1. `signupMemberEmailPassword` (or `auth.signupMemberEmailPassword`)
2. On documented `email-already-in-use` only → `loginMemberEmailPassword`
3. Access token from response: `result.data.tokens.accessToken` (MemberAuth)
4. `POST /api/onboarding/bootstrap` with header `X-Memberstack-Token`
5. Advance stepper only after bootstrap 200

Session resume uses `getMemberCookie()` when it returns a JWT string — not required after signup.

Attribution captured on load into `sessionStorage` (`wlth_attribution`) and sent on bootstrap.

Post-payment enrichment fields are stored only — **not** used for matching in this phase.
