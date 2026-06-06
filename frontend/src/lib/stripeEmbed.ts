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
    "background:#fff;border-radius:18px;max-width:480px;width:100%;max-height:92vh;overflow:auto;position:relative;box-shadow:0 16px 50px rgba(0,0,0,.4);";
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
  container.style.cssText = "padding:12px;min-height:60px;";
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
 * Run payout (Connect) onboarding. The returned promise resolves when the user
 * finishes or closes the flow, so the caller can re-check payout status. On
 * native (or without a publishable key) it opens the hosted onboarding link.
 */
export function stripeOnboarding(): Promise<void> {
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
        await loadScript("https://connect-js.stripe.com/v1.0/connect.js");
        const loader = (window as any).StripeConnect?.loadConnectAndInitialize || (window as any).loadConnectAndInitialize;
        if (!loader) return void hosted();
        const instance = loader({ publishableKey: PK, fetchClientSecret: async () => cs });
        // resolve() runs once, whether the user exits the component or closes the overlay.
        const { container, close } = makeOverlay(() => resolve());
        const comp = instance.create("account-onboarding");
        if (comp.setOnExit) comp.setOnExit(() => close());
        container.appendChild(comp);
      } catch {
        void hosted();
      }
    })();
  });
}
