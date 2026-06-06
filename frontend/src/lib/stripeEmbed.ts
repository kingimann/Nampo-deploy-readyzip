/**
 * Render Stripe inside the site (web) with a hard fallback to the hosted
 * redirect. On native — or if anything goes wrong, or the publishable key is
 * missing — it always falls back to the existing hosted Checkout/onboarding,
 * so a working payment flow can never break.
 */
import { Platform, Linking } from "react-native";
import { api } from "@/src/api/client";

const PK = (process.env.EXPO_PUBLIC_STRIPE_KEY as string) || "";
const isWeb = Platform.OS === "web" && typeof document !== "undefined";

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("stripe script failed"));
    document.head.appendChild(s);
  });
}

function makeOverlay(onClose?: () => void): { container: HTMLDivElement; close: () => void } {
  const overlay = document.createElement("div");
  overlay.setAttribute("data-stripe-overlay", "1");
  overlay.style.cssText =
    "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;";
  const card = document.createElement("div");
  card.style.cssText =
    "background:#fff;border-radius:18px;max-width:400px;width:100%;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;position:relative;box-shadow:0 16px 50px rgba(0,0,0,.4);";
  // Branded header so the embedded Stripe panel feels part of the site.
  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #eee;position:sticky;top:0;background:#fff;z-index:3;";
  const title = document.createElement("div");
  title.textContent = "🔒 Secure payment · Stripe";
  title.style.cssText = "font-size:13px;font-weight:800;color:#0b141a;letter-spacing:.2px;";
  const x = document.createElement("button");
  x.textContent = "✕";
  x.setAttribute("aria-label", "Close");
  x.style.cssText =
    "border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;color:#666;padding:2px 4px;";
  header.appendChild(title); header.appendChild(x);
  const container = document.createElement("div");
  container.style.cssText = "padding:12px;min-height:60px;overflow:auto;flex:1;";
  card.appendChild(header); card.appendChild(container); overlay.appendChild(card);
  document.body.appendChild(overlay);
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    try { document.body.removeChild(overlay); } catch {}
    try { onClose && onClose(); } catch {}
  };
  x.onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  return { container, close };
}

export async function stripeCheckout(args: {
  kind: "tip" | "subscription" | "promote";
  creator_id?: string;
  amount?: number;
  extra?: Record<string, any>;
}): Promise<boolean> {
  // Returns true if a checkout was launched (embedded or hosted), false if it
  // couldn't be created (e.g. the recipient hasn't set up payouts).
  const hosted = async (): Promise<boolean> => {
    try {
      const r = await api.createCheckout(args.kind, args.creator_id || "", args.amount || 0, args.extra || {});
      if (r.url) { await Linking.openURL(r.url); return true; }
      return false;
    } catch { return false; }
  };
  if (!isWeb || !PK) return hosted();
  try {
    const res = await api.createCheckout(args.kind, args.creator_id || "", args.amount || 0, { ...(args.extra || {}), embedded: true });
    const cs = res.client_secret;
    if (!cs) return hosted();
    await loadScript("https://js.stripe.com/v3/");
    const Stripe = (window as any).Stripe;
    if (!Stripe) return hosted();
    const stripe = Stripe(PK);
    const { container } = makeOverlay();
    const checkout = await stripe.initEmbeddedCheckout({ fetchClientSecret: async () => cs });
    checkout.mount(container);
    // On completion Stripe navigates the page to the session's return_url,
    // which tears down the overlay automatically.
    return true;
  } catch {
    return hosted();
  }
}

/**
 * Top up the wallet. Returns true if funds were credited immediately (test
 * mode) so the caller can refresh; for real Stripe it opens checkout (embedded
 * on web, hosted otherwise) and returns false.
 */
export async function stripeTopup(amount: number): Promise<boolean> {
  const hosted = async (embedded: boolean) => {
    const r = await api.topupWallet(amount, embedded);
    if (r.simulated) return true;           // credited instantly (test mode)
    if (r.url) { await Linking.openURL(r.url); return false; }
    return !!r.simulated;
  };
  if (!isWeb || !PK) return hosted(false);
  try {
    const res = await api.topupWallet(amount, true);
    if (res.simulated) return true;
    const cs = res.client_secret;
    if (!cs) return hosted(false);
    await loadScript("https://js.stripe.com/v3/");
    const Stripe = (window as any).Stripe;
    if (!Stripe) return hosted(false);
    const stripe = Stripe(PK);
    const { container } = makeOverlay();
    const checkout = await stripe.initEmbeddedCheckout({ fetchClientSecret: async () => cs });
    checkout.mount(container);
    return false;
  } catch {
    try { return await hosted(false); } catch { return false; }
  }
}

/**
 * Inline card top-up (Stripe Elements) — renders a compact card field right on
 * the site (number / expiry / CVC), like the old test sheet, instead of the
 * full embedded Checkout. Returns true if the wallet was credited. Falls back to
 * the embedded/hosted top-up on native or any failure.
 */
export async function stripeCardTopup(amount: number): Promise<boolean> {
  if (!isWeb || !PK) return stripeTopup(amount);
  let res: any;
  try { res = await api.createTopupIntent(amount); } catch { return stripeTopup(amount); }
  const cs = res?.client_secret;
  if (!cs) return stripeTopup(amount);
  try {
    await loadScript("https://js.stripe.com/v3/");
    const Stripe = (window as any).Stripe;
    if (!Stripe) return stripeTopup(amount);
    const stripe = Stripe(res.publishable_key || PK);
    const elements = stripe.elements();
    const card = elements.create("card", {
      style: { base: { fontSize: "16px", color: "#0b141a", "::placeholder": { color: "#9aa5a1" } } },
    });

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (v: boolean) => { if (settled) return; settled = true; resolve(v); };
      const { container, close } = makeOverlay(() => finish(false));

      const title = document.createElement("div");
      title.textContent = `Add $${amount.toFixed(2)} to your wallet`;
      title.style.cssText = "font-size:16px;font-weight:800;color:#0b141a;margin:4px 2px 12px;";
      const cardBox = document.createElement("div");
      cardBox.style.cssText = "border:1px solid #d6dcd9;border-radius:12px;padding:14px 12px;background:#fff;";
      const err = document.createElement("div");
      err.style.cssText = "color:#dc2626;font-size:13px;font-weight:600;margin:8px 2px 0;min-height:16px;";
      const pay = document.createElement("button");
      pay.textContent = `Pay $${amount.toFixed(2)}`;
      pay.style.cssText = "width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:#00A884;color:#fff;font-size:15px;font-weight:800;cursor:pointer;";
      const hint = document.createElement("div");
      hint.textContent = "🔒 Your card is processed securely by Stripe.";
      hint.style.cssText = "color:#7a8a85;font-size:11.5px;text-align:center;margin-top:10px;";

      container.appendChild(title);
      container.appendChild(cardBox);
      container.appendChild(err);
      container.appendChild(pay);
      container.appendChild(hint);
      card.mount(cardBox);

      pay.onclick = async () => {
        pay.disabled = true; pay.textContent = "Processing…"; err.textContent = "";
        try {
          const { error, paymentIntent } = await stripe.confirmCardPayment(cs, { payment_method: { card } });
          if (error) { err.textContent = error.message || "Payment failed."; pay.disabled = false; pay.textContent = `Pay $${amount.toFixed(2)}`; return; }
          if (paymentIntent && paymentIntent.status === "succeeded") {
            try { await api.confirmTopupIntent(res.intent_id); } catch {}
            finish(true); close();
          } else {
            err.textContent = "Payment didn't complete."; pay.disabled = false; pay.textContent = `Pay $${amount.toFixed(2)}`;
          }
        } catch (e: any) {
          err.textContent = String(e?.message || e) || "Something went wrong."; pay.disabled = false; pay.textContent = `Pay $${amount.toFixed(2)}`;
        }
      };
    });
  } catch {
    return stripeTopup(amount);
  }
}

// snake_case component keys the server enables → kebab-case names connect.js expects.
const COMPONENT_NAME: Record<string, string> = {
  account_onboarding: "account-onboarding",
  payouts: "payouts",
  account_management: "account-management",
  notification_banner: "notification-banner",
};

/**
 * Render an embedded Stripe Connect component inside the site. `preferred` is the
 * component we'd like (e.g. "payouts" for Manage payouts); if the account doesn't
 * support it we fall back to whatever the server enabled (always at least
 * onboarding/account-update) — so the panel still renders **in-app**. The hosted
 * Stripe redirect is only used on native, without a publishable key, or if the
 * embedded SDK genuinely can't load. Resolves when the user closes the panel.
 */
function embeddedConnectFlow(preferred: "account_onboarding" | "payouts" | "account_management"): Promise<void> {
  return new Promise<void>((resolve) => {
    const hosted = async () => {
      try { const { url } = await api.setupPayouts(); if (url) await Linking.openURL(url); } catch {}
      resolve();
    };
    if (!isWeb || !PK) return void hosted();
    (async () => {
      try {
        const res = await api.payoutAccountSession();
        const cs = res.client_secret;
        if (!cs) return void hosted();
        const enabled = res.components && res.components.length ? res.components : ["account_onboarding"];
        // Use the preferred component if the account supports it, else the richest
        // one available (payouts > account_management > onboarding) — never hosted.
        const pick = enabled.includes(preferred)
          ? preferred
          : (["payouts", "account_management", "account_onboarding"].find((c) => enabled.includes(c)) || "account_onboarding");
        await loadScript("https://connect-js.stripe.com/v1.0/connect.js");
        // The CDN connect.js exposes `window.StripeConnect.init(...)`; the
        // `loadConnectAndInitialize` name is the npm package's API (not on the
        // CDN global). Support both, and wait briefly in case `init` is defined
        // just after onload, so we don't wrongly fall back to the hosted redirect.
        const getLoader = () => {
          const SC = (window as any).StripeConnect;
          return { SC, fn: SC?.init || SC?.loadConnectAndInitialize || (window as any).loadConnectAndInitialize };
        };
        let { SC, fn: loader } = getLoader();
        for (let i = 0; !loader && i < 20; i++) {
          await new Promise((r) => setTimeout(r, 100));
          ({ SC, fn: loader } = getLoader());
        }
        if (!loader) return void hosted();
        const instance = loader.call(SC, {
          publishableKey: PK,
          fetchClientSecret: async () => cs,
          appearance: { variables: { colorPrimary: "#00A884" } },
        });
        // resolve() runs once, whether the user exits the component or closes the overlay.
        const { container, close } = makeOverlay(() => resolve());
        const comp = instance.create(COMPONENT_NAME[pick] || "account-onboarding");
        if (comp.setOnExit) comp.setOnExit(() => close());
        container.appendChild(comp);
      } catch {
        void hosted();
      }
    })();
  });
}

/**
 * Run payout (Connect) onboarding. The returned promise resolves when the user
 * finishes or closes the flow, so the caller can re-check payout status. On
 * native (or without a publishable key) it opens the hosted onboarding link.
 */
export function stripeOnboarding(): Promise<void> {
  return embeddedConnectFlow("account_onboarding");
}

/**
 * Embedded payout management (DoorDash-style): balance, payout schedule/history,
 * change bank or debit card, and instant cash-out — all in an in-site overlay so
 * the user never leaves the site. Falls back to the hosted Express dashboard on
 * native or if the embedded component can't load.
 */
export function stripeManagePayouts(): Promise<void> {
  return embeddedConnectFlow("payouts");
}
