# Real payments with Stripe Connect (optional)

The app ships with **test payments** (simulated tips/subscriptions credited
in-app). To take **real** money and pay creators out, connect Stripe. Until you
set `STRIPE_SECRET_KEY`, everything stays in test mode — nothing breaks.

How it works:
- Creators tap **Set up payouts** in their Wallet → a Stripe Connect **Express**
  account + hosted onboarding (they choose their bank/card). Their account id is
  saved on their user record.
- Buyers pay via **Stripe Checkout**; the charge is a *destination charge* to the
  creator's connected account, with an optional platform fee.
- A **webhook** credits the creator's in-app wallet on success, so the Wallet UI
  matches what you already see in test mode.

## 1. Stripe dashboard
1. Create a Stripe account → enable **Connect** (Settings → Connect).
2. Grab your **Secret key** (`sk_live_…` or `sk_test_…` for testing).
3. Add a webhook endpoint pointing at:
   `https://nampo-backend.onrender.com/api/payments/webhook`
   subscribe to **`checkout.session.completed`**, and copy its **signing secret**
   (`whsec_…`).

## 2. Environment variables (Render → nampo-backend)
| Variable | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | `sk_test_…` / `sk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` |
| `PLATFORM_FEE_PERCENT` | your cut, e.g. `0` or `10` |
| `WEB_APP_URL` | `https://nampo-web.onrender.com` (return URLs) |

Redeploy the backend (it auto-deploys on push; env changes need a redeploy).

## 3. Endpoints
- `GET  /api/payments/config` — `{ enabled }`
- `POST /api/payments/payouts/setup` — returns a hosted onboarding `url`
- `GET  /api/payments/payouts/status` — `{ connected, payouts_enabled, … }`
- `POST /api/payments/checkout` — `{ kind: "tip"|"subscription", creator_id, amount }` → hosted checkout `url`
- `POST /api/payments/webhook` — Stripe → credits the creator's wallet

## Notes / next steps
- **Subscriptions** currently use a one-time Checkout charge per period. For true
  auto-renewing subscriptions, create Stripe **Products/Prices** and switch the
  session to `mode="subscription"`.
- **Tips** support Stripe server-side; the in-app tip flow still uses the test
  sheet for variable-amount entry — wire it to `createCheckout("tip", …)` to go
  fully live.
- Use Stripe **test mode** keys + test cards first; flip to live keys when ready.
- On iOS, selling digital goods may require Apple In-App Purchase rather than
  Stripe — check Apple's rules for your use case (physical goods are exempt).
