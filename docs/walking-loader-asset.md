# WLTH WLKS widget loading animations

Shared component: `widgets/shared/AnimatedLoader.tsx`  
Asset map: `widgets/shared/animations.ts`  
Source directory: `widgets/shared/assets/animations/`

## State → animation mapping

| Application state | Variant | File | Suggested copy |
|---|---|---|---|
| General Signup transitions | `walking` | `walking-business-woman.lottie` | Saving / preparing next step |
| Stripe payment verification | `payment-verification` | `payment-verification.lottie` | Confirming your secure payment… |
| Payment confirmed (brief) | `payment-confirmed` | `payment-confirmed.lottie` | Payment confirmed |
| Loading Update Details | `profile-loading` | `profile-loading.lottie` | Welcome back! We’re loading your profile… |
| Saving Update Details | `profile-updating` | **MISSING** `profile-updating.lottie` | Updating your details… (CSS fallback until asset added) |

## Assets on disk

| Local filename | Display name (intended) | Creator (manifest) | Purpose | Download date |
|---|---|---|---|---|
| `walking-business-woman.lottie` | Walking business woman — Olena | LottieFiles (`dotLottie-js`) | General form transitions | 2026-08-02 |
| `payment-verification.lottie` | Payment verification | LottieFiles (`dotLottie-js`) | Stripe return / webhook wait | 2026-08-02 |
| `payment-confirmed.lottie` | Payment confirmed | LottieFiles (`dotLottie-js`) | Brief success after Paid | 2026-08-02 |
| `profile-loading.lottie` | Hello — Olena | LottieFiles (`dotLottie-js`) | Load member profile | 2026-08-02 |
| `profile-updating.lottie` | Get things done — Olena | — | **Not present in repo** | — |

**Licence:** As provided by the LottieFiles download for each asset (confirm Free/Premium terms on the original listing before redistribution). Player: `@lottiefiles/dotlottie-react` (MIT).

Do not claim every animation is by Olena unless verified on the original LottieFiles page. Manifest author field currently reads `LottieFiles` for all packaged files.

## Build output

```bash
npm run widgets:build
```

Emits under each widget:

```text
public/widgets/signup/v1/assets/animations/*.lottie
public/widgets/update-details/v1/assets/animations/*.lottie
```

Runtime resolves URLs relative to the widget `<script src>` so Webflow embeds load sibling assets without hotlinking.

## Accessibility

- `role="status"`, `aria-live="polite"`, `aria-busy="true"`
- Animation `aria-hidden`
- Title/description always visible
- `prefers-reduced-motion: reduce` → no loop/autoplay; first-frame segment

## Missing asset action

Add `widgets/shared/assets/animations/profile-updating.lottie`, then set in `animations.ts`:

```ts
"profile-updating": "profile-updating.lottie",
```

and add the filename to `ANIMATION_SOURCE_FILES`.
