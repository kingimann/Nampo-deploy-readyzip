# Forms

A Contact-Form-7-style form builder: build a form in-app, use it anywhere (in-app, a hosted page, or embedded on any website), collect responses, and get paid. In the app: **Settings → Forms**.

## Building
Open a form → **Build** tab. Add fields, set labels, mark required, reorder, and pick a type from the grouped picker (**Basic / Choice / Advanced**).

### Field types
- **Basic:** text, paragraph (textarea), email, phone, number, website/link (url), date, time
- **Choice:** dropdown (select), single choice (radio), checkboxes, **star rating** (1–5)
- **Advanced:**
  - **Section heading** — a non-input divider to organize long forms
  - **Signature** — draw-to-sign on the web (mouse/touch, captured as a PNG); typed e-signature in the in-app renderer
  - **Photo** — take or upload a photo
  - **Agreement / consent** — show terms / a **release of liability** the signer must accept via a required checkbox (you enter the legal text)
  - **Payment (Stripe)** — collect a payment; see [Paid forms](#paid-forms)

Other form settings: submit-button text, an optional **"email responses to"** override, and a completion **progress bar** shown to the filler.

## Using / embedding (Share tab)
- **In app:** open `/f/<form_key>`.
- **Hosted page:** `…/api/pub/form-unit?form=<form_key>`.
- **Embed on a website:** `…/api/pub/form-embed.js?form=<form_key>` (a `<script>` that drops in a themed iframe).

### Customize the embed
Via `data-*` on the script (or query params on `form-unit`):

| Knob | Effect |
| --- | --- |
| `theme` | `light` (default) or `dark` |
| `accent` / `bg` | colours (hex) |
| `radius` | corner radius (px) |
| `hide_title` | hide title + description |
| `redirect` | URL to send users to after submit |
| `data-prefill` (JSON) / `pf_<field_id>` | pre-fill fields |

The in-app **Share** tab has a live customizer (dark mode, accent swatches, hide-title, redirect, per-field prefill) that rewrites the snippet/link.

## Responses
**Responses** tab lists submissions (signatures/photos render inline). Export:
- **CSV** — `GET /forms/{id}/submissions.csv` (auth) or the in-app button.
- **PDF** — per-response **PDF** button (web) opens a print view (incl. signature/photo) → Save as PDF.

Owners are notified in-app + by email (account email or the per-form override), and developers can receive a **`form.submission` webhook** (see **[[Webhooks]]**).

## Paid forms
Add a **Payment** field to collect money on submit, routed to **your connected Stripe payout account** (set up payouts first: **Settings → Monetize**).

- **Amount:** fixed per form, or let the payer choose.
- **Flow (web):** submitting creates a Stripe **Checkout** session (destination charge to the owner + platform fee); on success the submission is recorded via the webhook (+ an on-return confirm), both idempotent. Endpoints: `POST /pub/form-checkout`, `GET /pub/form-paid`; the webhook handles `kind == "form_payment"`.
- The free `POST /pub/form-submit` returns **402** on paid forms (you must use checkout).
- In-app, paid forms route the user to the hosted page to complete payment.
- Requires `STRIPE_SECRET_KEY` (and `STRIPE_WEBHOOK_SECRET` for reliable finalization). See **[[Payments and Money]]**.

> PayPal is planned as a follow-up; Stripe is supported today.

## Anti-spam
A hidden **honeypot** field + a per-IP **rate limit** on public submit/checkout.
