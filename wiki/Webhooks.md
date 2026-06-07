# Webhooks

Developer webhooks let third parties receive a user's events on their own server. Requires an API plan that includes webhooks (Pro+). Manage them in **Settings → Developer API**.

## Register
`POST /webhooks` with `{ "url": "https://your-server/hook", "events": [...] }`. Omit `events` to receive all. A **signing secret** is returned **once** at creation. List subscribable events at `GET /webhooks/events`.

## Event types (20+)
Mirror the notification types that actually fire, e.g.: `follow`, `friend_request`, `friend_accept`, `poke`, `like`, `reply`, `repost`, `tag`, `message`, `group_message`, `group_invite`, `story_reply`, `tip`, `subscribe`, `payout`, `wallet_topup`, `roadside`, `support`, `call`, `moderation`, and **`form.submission`**.

## Delivery
- POSTed as JSON: `{ "event", "data", "created_at" }`.
- **Signed:** header `X-Nami-Signature: sha256=<hex>` — the HMAC-SHA256 of the **raw request body**, keyed with your signing secret. Also `X-Nami-Event`.
- **Retried** with backoff (3 attempts: immediate, +2s, +6s).
- Every attempt is recorded in a **delivery log**: `GET /webhooks/{id}/deliveries`.
- **Test ping:** `POST /webhooks/{id}/test` sends a signed sample `ping` and returns your endpoint's status.
- **Redeliver:** `POST /webhooks/{id}/deliveries/{delivery_id}/redeliver` re-sends a past payload.

## Verify the signature (Node / Express)
```js
import crypto from "crypto";

app.post("/hook", express.raw({ type: "*/*" }), (req, res) => {
  const sig = req.header("X-Nami-Signature") || "";              // "sha256=<hex>"
  const expected = "sha256=" + crypto
    .createHmac("sha256", process.env.NAMI_WEBHOOK_SECRET)
    .update(req.body)                                            // the RAW body
    .digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)))
    return res.status(401).end();
  const event = JSON.parse(req.body);                            // { event, data, created_at }
  res.sendStatus(200);
});
```
In any language: compute HMAC-SHA256 of the raw body with your secret and compare (constant-time) to the hex after `sha256=`.
