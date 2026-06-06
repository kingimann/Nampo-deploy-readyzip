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
 * onboarding/account-update). The in-app overlay opens immediately with a loading
 * state, and on failure it shows an in-app message — it never auto-redirects to an
 * external Stripe page (a tappable "secure page" link is offered only as a manual
 * last resort). Resolves when the user closes the panel.
 */
function embeddedConnectFlow(preferred: "account_onboarding" | "payouts" | "account_management"): Promise<void> {
  return new Promise<void>((resolve) => {
    // Native (no DOM) → there's no in-app web overlay, so use the hosted link.
    if (!isWeb) {
      (async () => { try { const { url } = await api.setupPayouts(); if (url) await Linking.openURL(url); } catch {} resolve(); })();
      return;
    }

    // Open the in-app panel right away so the user always sees something.
    const { container, close } = makeOverlay(() => resolve());
    const setMessage = (title: string, body: string, showLink: boolean) => {
      container.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.style.cssText = "padding:22px 18px;text-align:center;";
      const h = document.createElement("div");
      h.textContent = title;
      h.style.cssText = "font-size:16px;font-weight:800;color:#0b141a;margin-bottom:8px;";
      const p = document.createElement("div");
      p.textContent = body;
      p.style.cssText = "font-size:13.5px;color:#55636b;line-height:1.5;";
      wrap.appendChild(h); wrap.appendChild(p);
      if (showLink) {
        const a = document.createElement("button");
        a.textContent = "Continue on Stripe’s secure page";
        a.style.cssText = "margin-top:16px;padding:12px 16px;border:0;border-radius:10px;background:#00A884;color:#fff;font-size:14px;font-weight:800;cursor:pointer;";
        a.onclick = async () => { try { const { url } = await api.setupPayouts(); if (url) await Linking.openURL(url); } catch {} close(); };
        wrap.appendChild(a);
      }
      container.appendChild(wrap);
    };

    // Loading spinner while we set up the embedded component.
    const spinner = document.createElement("div");
    spinner.style.cssText = "padding:34px;display:flex;align-items:center;justify-content:center;";
    spinner.innerHTML = '<div style="width:26px;height:26px;border:3px solid #e3e8e6;border-top-color:#00A884;border-radius:50%;animation:nami-spin 0.8s linear infinite"></div>';
    if (!document.getElementById("nami-spin-style")) {
      const st = document.createElement("style");
      st.id = "nami-spin-style";
      st.textContent = "@keyframes nami-spin{to{transform:rotate(360deg)}}";
      document.head.appendChild(st);
    }
    container.appendChild(spinner);

    (async () => {
      try {
        if (!PK) { setMessage("Payouts unavailable", "Card payouts aren’t set up on this device build. Please try again from the website.", true); return; }
        const res = await api.payoutAccountSession();
        const cs = res.client_secret;
        if (!cs) { setMessage("Couldn’t start payouts", "We couldn’t reach Stripe just now. Please try again in a moment.", true); return; }
        const enabled = res.components && res.components.length ? res.components : ["account_onboarding"];
        const pick = enabled.includes(preferred)
          ? preferred
          : (["payouts", "account_management", "account_onboarding"].find((c) => enabled.includes(c)) || "account_onboarding");
        await loadScript("https://connect-js.stripe.com/v1.0/connect.js");
        // The CDN connect.js exposes `window.StripeConnect.init(...)`; the
        // `loadConnectAndInitialize` name is the npm package's API. Support both,
        // waiting briefly in case the global is defined just after onload.
        const getLoader = () => {
          const SC = (window as any).StripeConnect;
          return { SC, fn: SC?.init || SC?.loadConnectAndInitialize || (window as any).loadConnectAndInitialize };
        };
        let { SC, fn: loader } = getLoader();
        for (let i = 0; !loader && i < 30; i++) {
          await new Promise((r) => setTimeout(r, 100));
          ({ SC, fn: loader } = getLoader());
        }
        if (!loader) { setMessage("Couldn’t load Stripe", "The secure payout panel didn’t load. Please try again.", true); return; }
        const instance = loader.call(SC, {
          publishableKey: PK,
          fetchClientSecret: async () => cs,
          appearance: { variables: { colorPrimary: "#00A884" } },
        });
        const comp = instance && instance.create ? instance.create(COMPONENT_NAME[pick] || "account-onboarding") : null;
        if (!comp) { setMessage("Couldn’t open payouts", "The payout panel couldn’t start. Please try again.", true); return; }
        comp.style && (comp.style.display = "block");
        if (comp.setOnExit) comp.setOnExit(() => close());
        // Swap the spinner for the live component.
        container.innerHTML = "";
        container.appendChild(comp);
      } catch {
        setMessage("Something went wrong", "We couldn’t open the payout panel. Please try again.", true);
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

/**
 * Add / update a payout method (e.g. a debit card for instant cash-out). Opens
 * the embedded account-management component (which collects external accounts)
 * in the in-site overlay — no external page.
 */
export function stripeAddPayoutMethod(): Promise<void> {
  return embeddedConnectFlow("account_management");
}

/**
 * Inline debit-card entry for payouts — renders a card field right in the app
 * (like the top-up sheet), tokenizes it against the connected account, and
 * attaches it as the payout method server-side. Works on any account type and
 * never leaves the app. Returns true if a card was added.
 */
export async function stripeAddDebitCard(acctId: string, currency?: string): Promise<boolean> {
  if (!isWeb || !PK || !acctId) return false;
  try {
    await loadScript("https://js.stripe.com/v3/");
    const Stripe = (window as any).Stripe;
    if (!Stripe) return false;
    // Tokenize on behalf of the connected account so the card can become its
    // external (payout) account.
    const stripe = Stripe(PK, { stripeAccount: acctId });
    const elements = stripe.elements();
    const card = elements.create("card", {
      hidePostalCode: false,
      style: { base: { fontSize: "16px", color: "#0b141a", "::placeholder": { color: "#9aa5a1" } } },
    });

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (v: boolean) => { if (settled) return; settled = true; resolve(v); };
      const { container, close } = makeOverlay(() => finish(false));

      const title = document.createElement("div");
      title.textContent = "Add a debit card to cash out";
      title.style.cssText = "font-size:16px;font-weight:800;color:#0b141a;margin:4px 2px 4px;";
      const sub = document.createElement("div");
      sub.textContent = "Instant cash-out sends money straight to this debit card. Credit and most prepaid cards aren’t eligible.";
      sub.style.cssText = "font-size:12.5px;color:#55636b;line-height:1.45;margin:0 2px 12px;";
      const cardBox = document.createElement("div");
      cardBox.style.cssText = "border:1px solid #d6dcd9;border-radius:12px;padding:14px 12px;background:#fff;";
      const err = document.createElement("div");
      err.style.cssText = "color:#dc2626;font-size:13px;font-weight:600;margin:8px 2px 0;min-height:16px;";
      const save = document.createElement("button");
      save.textContent = "Save debit card";
      save.style.cssText = "width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:#00A884;color:#fff;font-size:15px;font-weight:800;cursor:pointer;";
      const hint = document.createElement("div");
      hint.textContent = "🔒 Your card is processed securely by Stripe.";
      hint.style.cssText = "color:#7a8a85;font-size:11.5px;text-align:center;margin-top:10px;";

      container.appendChild(title);
      container.appendChild(sub);
      container.appendChild(cardBox);
      container.appendChild(err);
      container.appendChild(save);
      container.appendChild(hint);
      card.mount(cardBox);

      save.onclick = async () => {
        save.disabled = true; save.textContent = "Saving…"; err.textContent = "";
        try {
          const data: any = {};
          if (currency) data.currency = currency;
          const { token, error } = await stripe.createToken(card, data);
          if (error) { err.textContent = error.message || "Couldn’t read that card."; save.disabled = false; save.textContent = "Save debit card"; return; }
          await api.addDebitCard(token.id);
          finish(true); close();
        } catch (e: any) {
          err.textContent = String(e?.message || e).replace(/^\d{3}:\s*/, "") || "Couldn’t add that card."; save.disabled = false; save.textContent = "Save debit card";
        }
      };
    });
  } catch {
    return false;
  }
}

/**
 * Inline bank-account (direct deposit) entry — a plain in-app form. The numbers
 * are tokenized client-side by Stripe.js (never sent to our server) and attached
 * as the connected account's bank payout method. Returns true if added.
 */
export async function stripeAddBankAccount(acctId: string, country?: string, currency?: string): Promise<boolean> {
  if (!isWeb || !PK || !acctId) return false;
  try {
    await loadScript("https://js.stripe.com/v3/");
    const Stripe = (window as any).Stripe;
    if (!Stripe) return false;
    const stripe = Stripe(PK, { stripeAccount: acctId });
    const cc = (country || "US").toUpperCase();
    const ccy = (currency || (cc === "CA" ? "cad" : "usd")).toLowerCase();
    const routingLabel = cc === "CA" ? "Transit + institution (e.g. 11000-000)" : cc === "GB" ? "Sort code" : "Routing number";

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (v: boolean) => { if (settled) return; settled = true; resolve(v); };
      const { container, close } = makeOverlay(() => finish(false));

      const title = document.createElement("div");
      title.textContent = "Add direct deposit (bank account)";
      title.style.cssText = "font-size:16px;font-weight:800;color:#0b141a;margin:4px 2px 4px;";
      const sub = document.createElement("div");
      sub.textContent = "Standard payouts are sent to this bank account on your schedule.";
      sub.style.cssText = "font-size:12.5px;color:#55636b;line-height:1.45;margin:0 2px 12px;";

      const mkInput = (placeholder: string) => {
        const i = document.createElement("input");
        i.placeholder = placeholder;
        i.style.cssText = "width:100%;box-sizing:border-box;border:1px solid #d6dcd9;border-radius:10px;padding:13px 12px;font-size:15px;color:#0b141a;margin-top:8px;background:#fff;";
        return i;
      };
      const nameI = mkInput("Account holder name");
      const routingI = mkInput(routingLabel);
      const acctI = mkInput("Account number");
      acctI.setAttribute("inputmode", "numeric");

      const err = document.createElement("div");
      err.style.cssText = "color:#dc2626;font-size:13px;font-weight:600;margin:8px 2px 0;min-height:16px;";
      const save = document.createElement("button");
      save.textContent = "Save bank account";
      save.style.cssText = "width:100%;margin-top:14px;padding:14px;border:0;border-radius:12px;background:#00A884;color:#fff;font-size:15px;font-weight:800;cursor:pointer;";
      const hint = document.createElement("div");
      hint.textContent = "🔒 Your bank details are encrypted and tokenized by Stripe.";
      hint.style.cssText = "color:#7a8a85;font-size:11.5px;text-align:center;margin-top:10px;";

      [title, sub, nameI, routingI, acctI, err, save, hint].forEach((el) => container.appendChild(el));

      save.onclick = async () => {
        if (!nameI.value.trim() || !routingI.value.trim() || !acctI.value.trim()) { err.textContent = "Please fill in every field."; return; }
        save.disabled = true; save.textContent = "Saving…"; err.textContent = "";
        try {
          const { token, error } = await stripe.createToken("bank_account", {
            country: cc, currency: ccy,
            account_holder_name: nameI.value.trim(),
            account_holder_type: "individual",
            routing_number: routingI.value.replace(/\s|-/g, ""),
            account_number: acctI.value.replace(/\s/g, ""),
          });
          if (error) { err.textContent = error.message || "Couldn’t read those bank details."; save.disabled = false; save.textContent = "Save bank account"; return; }
          await api.addBankAccount(token.id);
          finish(true); close();
        } catch (e: any) {
          err.textContent = String(e?.message || e).replace(/^\d{3}:\s*/, "") || "Couldn’t add that account."; save.disabled = false; save.textContent = "Save bank account";
        }
      };
    });
  } catch {
    return false;
  }
}
