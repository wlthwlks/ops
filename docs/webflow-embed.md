# Webflow embed

## Signup (`/apply`)

```html
<div id="wlth-signup-root" data-api-base="https://ops.wlthwlks.com"></div>
<link rel="stylesheet" href="https://ops.wlthwlks.com/widgets/signup/v1/signup.css" />
<script src="https://ops.wlthwlks.com/widgets/signup/v1/signup.js" defer></script>
```

Also load Memberstack DOM script with your public key on the page.

## Update details

```html
<div id="wlth-update-details-root" data-api-base="https://ops.wlthwlks.com"></div>
<link rel="stylesheet" href="https://ops.wlthwlks.com/widgets/update-details/v1/update-details.css" />
<script src="https://ops.wlthwlks.com/widgets/update-details/v1/update-details.js" defer></script>
```

## Staging

1. Embed only on Webflow staging / password pages first.
2. Point `data-api-base` at a preview Vercel deployment.
3. Keep production Tally until validated.
