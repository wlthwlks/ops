# Signup widget

Build: `npm run widgets:build:signup` → `public/widgets/signup/v1/`.

UI stack: **@stepperize/react** (linear steps) + **react-hook-form** + **Zod** (`widgets/shared/widget-schemas.ts`) + scoped `.wlth-widget` CSS.

Stages: Account → Location → Business → Payment (Memberstack checkout) → Success → Goal → Help → Expertise → Connection → home.

Autosave via `PATCH /api/onboarding/step` when Memberstack token is present.

Attribution captured on load into `sessionStorage` (`wlth_attribution`) and sent on bootstrap.

Post-payment enrichment fields are stored only — **not** used for matching in this phase.
