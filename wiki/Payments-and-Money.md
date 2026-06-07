# Payments and Money

Real payments via **Stripe** when configured (`STRIPE_SECRET_KEY`); otherwise the app falls back to a **simulated** checkout (test mode is off by default). Money is stored in USD and shown in a display currency the user chooses.

## What can be paid for
- **Tips** and monthly **subscriptions** to creators
- **Post promotion** (ads) and **ad-account** top-ups
- **Wallet** top-ups and **API** plans / usage packs
- **Paid forms** — see **[[Forms]]**

Creator payments use **Stripe Connect destination charges**: the buyer is charged and the funds are transferred to the creator's connected account, minus a platform fee.

## Platform fee
- `PLATFORM_FEE_PERCENT` (env, admin-tunable via `/admin/fees`) — percentage cut of subscriptions/tips/form payments.
- A flat **transaction fee** (cents) is added on one-time charges.
- For one-time charges: `application_fee_amount = round(gross * fee% ) + transaction_fee`, clamped below gross.

## Wallet
- **Balance** you top up (credited via webhook + on-return confirm + per-visit reconcile, so a payment can't be missed).
- **Instant cash-out** to a debit card (Stripe Instant Payouts): $5 minimum, $1.99 flat fee, disabled until a debit card is attached.
- **Display currency** (12 currencies).
- Unified **"All activity"** feed (`/wallet/activity`): top-ups, cash-outs, tips/subscriptions (sent & received), and transfers.

## Fully in-app payouts (no Stripe-hosted screens)
Identity verification (`/verify-payouts`), **debit card** (`/add-card`), and **bank details** (`/add-bank`) are native forms tokenized client-side by Stripe.js. KYC is sent with `Account.update`; the only Stripe-owned pixels are the PCI card-number field. Payout schedule: weekly (default) / bi-weekly / monthly, changeable once a month.

## Peer-to-peer money
Send money (gated by a personal **security question**) and **request** money. Sends are a pending transfer the recipient accepts; the sender has a **5-minute reversal window**. **Pay by QR**: a branded on-device pay code + an in-app scanner.

## Webhook
Point Stripe at `POST {backend}/api/payments/webhook` and set `STRIPE_WEBHOOK_SECRET`. The handler dispatches on `checkout.session.completed` by a `kind` in metadata: `tip` / `subscription` / `promote` / `ad_topup` / `wallet_topup` / `api_plan` / `api_usage` / **`form_payment`**.

## Admin
**Settings → Payments & data (admin)**: toggle simulated payments, set the revenue split + transaction fee, view platform revenue, and set a user's wallet balance. See **[[Admin Tools]]**.
