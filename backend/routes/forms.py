"""Custom forms — build forms in-app, use them around the site, and let
developers embed them on their own websites (Contact-Form-7 style).

An owner creates a form (gets a public `form_key`), drops in a snippet, and we
serve a self-contained form into an iframe. Submissions are stored and the owner
is notified (in-app + email). Public endpoints under `/pub/form*` take no auth —
the `form_key` identifies the form. Spam is curbed with a hidden honeypot field
and a lightweight per-IP rate limit.
"""
import csv
import html
import io
import json
import math
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, List, Optional

import httpx

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel, ConfigDict

from core import db, get_current_user

router = APIRouter()

FIELD_TYPES = {"text", "email", "phone", "number", "textarea", "select", "checkbox", "radio",
               "date", "time", "url", "rating", "heading", "address", "password",
               "signature", "photo", "consent", "payment"}
MAX_FIELDS = 40
MAX_VALUE_LEN = 5000
SIG_MAX_LEN = 400_000     # drawn signature → PNG data URL
PHOTO_MAX_LEN = 8_000_000  # an uploaded/taken photo data URL
CONSENT_TEXT_MAX = 6000   # terms / liability agreement text shown to the signer
MAX_TITLE = 120

# Lightweight in-memory rate limit for the public submit endpoint (single
# instance; resets on restart). Keyed by (form_key, ip).
_RATE: dict = {}
RATE_MAX = 5
RATE_WINDOW = 60.0

# A more permissive limiter for address autocomplete (it fires while typing).
_GEO_RATE: dict = {}
GEO_MAX = 40


def _geo_ok(ip: str) -> bool:
    now = time.time()
    # Global ceiling first — the per-IP key comes from X-Forwarded-For, which a
    # caller can rotate to dodge the per-IP cap and drain the Mapbox quota, so
    # also bound total geocode calls across all callers in the window.
    g = [t for t in _GEO_RATE.get("__global__", []) if now - t < RATE_WINDOW]
    if len(g) >= GEO_MAX * 50:
        _GEO_RATE["__global__"] = g
        return False
    hits = [t for t in _GEO_RATE.get(ip, []) if now - t < RATE_WINDOW]
    if len(hits) >= GEO_MAX:
        _GEO_RATE[ip] = hits
        return False
    hits.append(now)
    _GEO_RATE[ip] = hits
    g.append(now)
    _GEO_RATE["__global__"] = g
    return True


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return (request.client.host if request.client else "") or "?"


def _rate_ok(form_key: str, ip: str) -> bool:
    now = time.time()
    key = (form_key, ip)
    hits = [t for t in _RATE.get(key, []) if now - t < RATE_WINDOW]
    if len(hits) >= RATE_MAX:
        _RATE[key] = hits
        return False
    hits.append(now)
    _RATE[key] = hits
    return True


def _public_base(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto") or request.url.scheme or "https"
    proto = proto.split(",")[0].strip()
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}"


class FormField(BaseModel):
    id: Optional[str] = None
    type: str = "text"
    label: str = ""
    required: bool = False
    placeholder: Optional[str] = None
    options: Optional[List[str]] = None      # select / radio / checkbox
    text: Optional[str] = None               # consent: the terms / liability text to agree to
    amount: Optional[float] = None           # payment: fixed price
    amount_open: Optional[bool] = None       # payment: let the payer choose the amount
    currency: Optional[str] = None           # payment: ISO currency (default USD)


class FormCreate(BaseModel):
    title: str
    description: Optional[str] = None
    submit_label: Optional[str] = None
    notify_email: Optional[str] = None        # send submissions here instead of the owner's account email
    ai_validate: Optional[bool] = None        # run an AI completeness/plausibility check on each submission
    fields: List[FormField] = []


class FormSubmit(BaseModel):
    values: dict = {}
    hp: Optional[str] = None                  # honeypot — must be empty


def _clean_notify_email(s: Optional[str]) -> Optional[str]:
    """Validate the optional per-form recipient. Empty means 'use account email'."""
    s = (s or "").strip()
    if not s:
        return None
    if len(s) > 200 or "@" not in s or "." not in s.split("@")[-1]:
        raise HTTPException(status_code=400, detail="Enter a valid email address for responses, or leave it blank.")
    return s.lower()


def _fmt_dt(v) -> str:
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v or "")


def _hex(s: Optional[str]) -> Optional[str]:
    """Accept a 3- or 6-digit hex colour (with or without '#'); else None."""
    s = (s or "").strip().lstrip("#")
    if re.fullmatch(r"[0-9a-fA-F]{3}", s) or re.fullmatch(r"[0-9a-fA-F]{6}", s):
        return "#" + s
    return None


def _embed_config(theme: str, accent: Optional[str], bg: Optional[str], radius: Optional[str],
                  hide_title: Optional[str], redirect: Optional[str], prefill: dict) -> dict:
    """Resolve the look-and-behaviour knobs an embedder can pass, with safe
    defaults. Dark mode swaps a WhatsApp-style palette; colours are validated."""
    dark = (theme or "").strip().lower() == "dark"
    try:
        rad = max(0, min(28, int(radius)))
    except (TypeError, ValueError):
        rad = 10
    red = redirect if (redirect or "").startswith(("http://", "https://")) else None
    return {
        "accent": _hex(accent) or "#00A884",
        "bg": _hex(bg) or ("#0b141a" if dark else "#ffffff"),
        "text": "#e9edef" if dark else "#0b0b0c",
        "muted": "#8696a0" if dark else "#5b6770",
        "border": "#2a3942" if dark else "#cfd6db",
        "fieldBg": "#111b21" if dark else "#ffffff",
        "radius": rad,
        "hideTitle": bool(hide_title),
        "redirect": red,
        "prefill": {str(k)[:60]: str(v)[:500] for k, v in (prefill or {}).items()},
    }


def _safe_filename(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", (s or "")).strip("-").lower()
    return s or "form"


def _clean_fields(fields: List[FormField]) -> list:
    out = []
    for i, f in enumerate((fields or [])[:MAX_FIELDS]):
        t = (f.type or "text").strip().lower()
        if t not in FIELD_TYPES:
            t = "text"
        opts = None
        if t in ("select", "radio", "checkbox"):
            opts = [str(o).strip()[:120] for o in (f.options or []) if str(o).strip()][:30] or ["Option 1"]
        item = {
            "id": (f.id or f"f{i + 1}").strip()[:40] or f"f{i + 1}",
            "type": t,
            "label": (f.label or "").strip()[:120] or f"Field {i + 1}",
            "required": bool(f.required),
            "placeholder": (f.placeholder or "").strip()[:160] or None,
            "options": opts,
            "text": ((f.text or "").strip()[:CONSENT_TEXT_MAX] or None) if t == "consent" else None,
        }
        if t == "payment":
            try:
                amt = round(float(f.amount or 0), 2)
            except (TypeError, ValueError):
                amt = 0.0
            item["amount"] = max(0.0, amt)
            item["amount_open"] = bool(f.amount_open)
            item["currency"] = (f.currency or "USD").strip().upper()[:3] or "USD"
        out.append(item)
    return out


def _form_view(f: dict) -> dict:
    return {
        "id": f["id"], "owner_id": f.get("owner_id"), "form_key": f.get("form_key"),
        "title": f.get("title"), "description": f.get("description"),
        "submit_label": f.get("submit_label") or "Submit",
        "notify_email": f.get("notify_email"),
        "ai_validate": bool(f.get("ai_validate")),
        "fields": f.get("fields") or [],
        "submissions": int(f.get("submissions", 0) or 0),
        "created_at": f.get("created_at"),
    }


def _public_form_view(f: dict) -> dict:
    return {
        "id": f["id"], "title": f.get("title"), "description": f.get("description"),
        "submit_label": f.get("submit_label") or "Submit", "fields": f.get("fields") or [],
    }


# ── Owner CRUD (authenticated) ───────────────────────────────────────────────
# --- §1 response models (extra="allow" so no field is ever dropped) ----------
class _FOut(BaseModel):
    model_config = ConfigDict(extra="allow")


class OkResultOut(_FOut):
    ok: bool = True


class FormsListOut(_FOut):
    forms: list = []


class SubmissionsOut(_FOut):
    submissions: list = []
    total: int = 0
    fields: list = []


class FormOut(_FOut):
    id: str
    owner_id: Optional[str] = None
    form_key: Optional[str] = None
    title: Optional[str] = None
    description: Optional[str] = None
    submit_label: str = "Submit"
    notify_email: Optional[str] = None
    ai_validate: bool = False
    fields: list = []
    submissions: int = 0
    created_at: Optional[Any] = None


class GeocodeOut(_FOut):
    results: list = []


class CheckoutUrlOut(_FOut):
    url: Optional[str] = None


@router.post("/forms", response_model=FormOut)
async def create_form(body: FormCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    title = (body.title or "").strip()[:MAX_TITLE]
    if not title:
        raise HTTPException(status_code=400, detail="A form title is required.")
    doc = {
        "id": str(uuid.uuid4()),
        "owner_id": user["user_id"],
        "form_key": "form_" + uuid.uuid4().hex,
        "title": title,
        "description": (body.description or "").strip()[:500] or None,
        "submit_label": (body.submit_label or "").strip()[:40] or "Submit",
        "notify_email": _clean_notify_email(body.notify_email),
        "ai_validate": bool(body.ai_validate),
        "fields": _clean_fields(body.fields),
        "submissions": 0,
        "created_at": datetime.now(timezone.utc),
    }
    await db.forms.insert_one(doc.copy())
    return _form_view(doc)


@router.get("/forms", response_model=FormsListOut)
async def list_forms(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    rows = await db.forms.find({"owner_id": user["user_id"]}, {"_id": 0}).sort("created_at", -1).limit(100).to_list(100)
    return {"forms": [_form_view(r) for r in rows]}


@router.get("/forms/{form_id}", response_model=FormOut)
async def get_form(form_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.forms.find_one({"id": form_id, "owner_id": user["user_id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Form not found")
    return _form_view(doc)


@router.post("/forms/{form_id}", response_model=FormOut)
async def update_form(form_id: str, body: FormCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.forms.find_one({"id": form_id, "owner_id": user["user_id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Form not found")
    title = (body.title or "").strip()[:MAX_TITLE]
    if not title:
        raise HTTPException(status_code=400, detail="A form title is required.")
    updates = {
        "title": title,
        "description": (body.description or "").strip()[:500] or None,
        "submit_label": (body.submit_label or "").strip()[:40] or "Submit",
        "notify_email": _clean_notify_email(body.notify_email),
        "ai_validate": bool(body.ai_validate),
        "fields": _clean_fields(body.fields),
    }
    await db.forms.update_one({"id": form_id}, {"$set": updates})
    doc.update(updates)
    return _form_view(doc)


@router.delete("/forms/{form_id}", response_model=OkResultOut)
async def delete_form(form_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    res = await db.forms.delete_one({"id": form_id, "owner_id": user["user_id"]})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Form not found")
    await db.form_submissions.delete_many({"form_id": form_id})
    return {"ok": True}


@router.get("/forms/{form_id}/submissions", response_model=SubmissionsOut)
async def list_submissions(form_id: str, limit: int = Query(50), offset: int = Query(0), authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    form = await db.forms.find_one({"id": form_id, "owner_id": user["user_id"]}, {"_id": 0})
    if not form:
        raise HTTPException(status_code=404, detail="Form not found")
    lim = max(1, min(int(limit or 50), 100))
    rows = await db.form_submissions.find({"form_id": form_id}, {"_id": 0}).sort("submitted_at", -1).skip(max(0, int(offset or 0))).limit(lim).to_list(lim)
    total = await db.form_submissions.count_documents({"form_id": form_id})
    return {"submissions": rows, "total": total, "fields": form.get("fields") or []}


@router.get("/forms/{form_id}/submissions.csv")
async def export_submissions_csv(form_id: str, authorization: Optional[str] = Header(None)):
    """Download every response as a CSV — one column per field, plus a timestamp."""
    user = await get_current_user(authorization)
    form = await db.forms.find_one({"id": form_id, "owner_id": user["user_id"]}, {"_id": 0})
    if not form:
        raise HTTPException(status_code=404, detail="Form not found")
    fields = form.get("fields") or []
    rows = await db.form_submissions.find({"form_id": form_id}, {"_id": 0}).sort("submitted_at", 1).limit(10000).to_list(10000)
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Submitted at"] + [(f.get("label") or f.get("id") or "") for f in fields])
    for r in rows:
        vals = r.get("values") or {}
        writer.writerow([_fmt_dt(r.get("submitted_at"))] + [str(vals.get(f.get("id"), "")) for f in fields])
    fname = _safe_filename(form.get("title") or "form") + "-responses.csv"
    return Response(
        content=buf.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


# ── Public render + submit (no auth — form_key identifies the form) ───────────
@router.get("/pub/form")
async def public_form(form: str = Query(...)):
    doc = await db.forms.find_one({"form_key": form}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Form not found")
    return _public_form_view(doc)


@router.get("/pub/geocode", response_model=GeocodeOut)
async def pub_geocode(request: Request, q: str = Query(...)):
    """Address autocomplete for form 'address' fields — proxies Mapbox forward
    geocoding with the backend MAPBOX_TOKEN so the public form never sees a token.
    Returns [] when MAPBOX_TOKEN isn't set (the field still works as plain text)."""
    if not _geo_ok(_client_ip(request)):
        return {"results": []}
    token = os.environ.get("MAPBOX_TOKEN", "")
    if not token or len((q or "").strip()) < 3:
        return {"results": []}
    try:
        async with httpx.AsyncClient(timeout=8) as c:
            r = await c.get(
                "https://api.mapbox.com/search/geocode/v6/forward",
                params={"q": q, "limit": 6, "access_token": token},
            )
        feats = (r.json() or {}).get("features", []) if r.status_code == 200 else []
    except Exception:
        feats = []
    out = []
    for f in feats:
        p = f.get("properties") or {}
        g = f.get("geometry") or {}
        coords = g.get("coordinates") or [None, None]
        out.append({
            "name": p.get("name") or "",
            "full_address": p.get("full_address") or p.get("place_formatted") or p.get("name") or "",
            "lng": coords[0], "lat": coords[1],
        })
    return {"results": out}


def _payment_field(doc: dict) -> Optional[dict]:
    for f in (doc.get("fields") or []):
        if f.get("type") == "payment":
            return f
    return None


def _clean_values(fields: list, values: dict) -> dict:
    """Coerce + validate submitted values against the form's fields."""
    values = values if isinstance(values, dict) else {}
    clean: dict = {}
    for f in fields:
        ft = f.get("type")
        if ft == "heading":
            continue
        raw = values.get(f["id"])
        cap = PHOTO_MAX_LEN if ft == "photo" else SIG_MAX_LEN if ft == "signature" else MAX_VALUE_LEN
        val = (", ".join(str(x) for x in raw) if isinstance(raw, list) else ("" if raw is None else str(raw)))[:cap]
        if f.get("required") and ft != "payment" and not val.strip():
            raise HTTPException(status_code=400, detail=f"{f.get('label') or 'A field'} is required.")
        clean[f["id"]] = val
    return clean


def _email_short(v, ftype: str = "") -> str:
    if ftype == "password":
        return "••••••" if str(v).strip() else ""
    s = str(v)
    return "[attachment]" if s.startswith("data:") else s[:500]


async def _ai_check(doc: dict, clean: dict) -> None:
    """When the form has AI validation on, ask the local AI to confirm answers
    look properly filled in; raise 400 listing issues so the filler can fix them."""
    if not doc.get("ai_validate"):
        return
    try:
        from services.ollama import validate_form_submission
        issues = await validate_form_submission(doc.get("fields") or [], clean)
    except Exception:
        issues = []
    if issues:
        raise HTTPException(status_code=400, detail="Please review: " + "; ".join(issues))


async def _record_submission(doc: dict, clean: dict, ip: str, payment: Optional[dict] = None) -> str:
    """Persist a submission and fan out notification + webhook + email. Shared by
    the free submit path and the paid (Stripe) finalize path."""
    fields = doc.get("fields") or []
    by_id = {f["id"]: f for f in fields}
    sub = {
        "id": str(uuid.uuid4()),
        "form_id": doc["id"], "owner_id": doc["owner_id"],
        "values": clean, "ip": (ip or "")[:60],
        "submitted_at": datetime.now(timezone.utc),
    }
    if payment:
        sub["payment"] = payment
    await db.form_submissions.insert_one(sub.copy())
    await db.forms.update_one({"id": doc["id"]}, {"$inc": {"submissions": 1}})
    try:
        from routes.notifications import emit_notification
        await emit_notification(user_id=doc["owner_id"], actor_id=None, ntype="form",
                                message=f"New submission on “{doc.get('title')}”.")
    except Exception:
        pass
    try:
        from routes.webhooks import deliver_event
        await deliver_event(doc["owner_id"], "form.submission", {
            "form_id": doc["id"], "form_key": doc.get("form_key"), "title": doc.get("title"),
            "submission_id": sub["id"], "values": clean, "payment": payment,
            "submitted_at": _fmt_dt(sub["submitted_at"]),
        })
    except Exception:
        pass
    try:
        recipient = doc.get("notify_email")
        if not recipient:
            owner = await db.users.find_one({"user_id": doc["owner_id"]}, {"_id": 0, "email": 1})
            recipient = owner.get("email") if owner else None
        if recipient:
            from services.email import send_email, email_enabled
            if email_enabled():
                lines = "\n".join(f"- {by_id.get(k, {}).get('label', k)}: {_email_short(v, by_id.get(k, {}).get('type', ''))}" for k, v in clean.items())
                if payment:
                    lines = f"- Payment: {payment.get('currency', 'USD')} {payment.get('amount')} (paid)\n" + lines
                send_email(recipient, f"New submission: {doc.get('title')}",
                           f"You received a new form submission:\n\n{lines}")
    except Exception:
        pass
    return sub["id"]


@router.post("/pub/form-submit", response_model=OkResultOut)
async def public_submit(request: Request, body: FormSubmit, form: str = Query(...)):
    doc = await db.forms.find_one({"form_key": form}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Form not found")
    if (body.hp or "").strip():          # honeypot — accept silently, store nothing
        return {"ok": True}
    if _payment_field(doc):
        raise HTTPException(status_code=402, detail="This form requires payment — use the payment button.")
    ip = _client_ip(request)
    if not _rate_ok(form, ip):
        raise HTTPException(status_code=429, detail="Too many submissions — wait a minute and try again.")
    clean = _clean_values(doc.get("fields") or [], body.values)
    await _ai_check(doc, clean)
    await _record_submission(doc, clean, ip)
    return {"ok": True}


async def finalize_form_payment(pending_id: str) -> bool:
    """Turn a paid pending payment into a real submission (idempotent — the
    status flip is the lock so the webhook and the on-return confirm can't double)."""
    res = await db.form_pending.update_one({"id": pending_id, "status": "pending"}, {"$set": {"status": "paid"}})
    if not res or getattr(res, "matched_count", 0) == 0:
        return False
    p = await db.form_pending.find_one({"id": pending_id}, {"_id": 0})
    doc = await db.forms.find_one({"id": p["form_id"]}, {"_id": 0}) if p else None
    if not doc:
        return False
    await _record_submission(
        doc, p.get("values") or {}, p.get("ip", ""),
        payment={"amount": p.get("amount"), "currency": p.get("currency"), "status": "paid"},
    )
    return True


@router.post("/pub/form-checkout", response_model=CheckoutUrlOut)
async def form_checkout(request: Request, body: FormSubmit, form: str = Query(...)):
    """Create a Stripe Checkout session for a paid form — the charge is routed to
    the form owner's connected account; the submission is recorded on payment."""
    doc = await db.forms.find_one({"form_key": form}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Form not found")
    pay = _payment_field(doc)
    if not pay:
        raise HTTPException(status_code=400, detail="This form has no payment.")
    if (body.hp or "").strip():
        return {"ok": True}
    ip = _client_ip(request)
    if not _rate_ok(form, ip):
        raise HTTPException(status_code=429, detail="Too many attempts — wait a minute.")
    clean = _clean_values(doc.get("fields") or [], body.values)
    await _ai_check(doc, clean)
    cur = (pay.get("currency") or "USD").upper()
    if pay.get("amount_open"):
        try:
            amt = round(float((body.values or {}).get(pay["id"]) or 0), 2)
        except (TypeError, ValueError):
            amt = 0.0
        # Open amounts are buyer-supplied — reject non-finite / absurd values
        # (e.g. "1e9") before building a Stripe line item.
        if not math.isfinite(amt) or amt > 100000:
            raise HTTPException(status_code=400, detail="Enter a valid amount.")
    else:
        amt = round(float(pay.get("amount") or 0), 2)
    if amt < 0.50:
        raise HTTPException(status_code=400, detail="Enter a valid amount.")
    from routes.payments import stripe, stripe_enabled, platform_fee_percent, transaction_fee_cents
    if not stripe_enabled():
        raise HTTPException(status_code=400, detail="Payments aren't enabled on this site.")
    owner = await db.users.find_one({"user_id": doc["owner_id"]}, {"_id": 0, "stripe_account_id": 1})
    dest = (owner or {}).get("stripe_account_id")
    if not dest:
        raise HTTPException(status_code=400, detail="The form owner hasn't set up payouts yet.")
    gross_cents = int(round(amt * 100))
    try:
        fee_cents = int(round(gross_cents * (await platform_fee_percent()) / 100.0)) + (await transaction_fee_cents())
    except Exception:
        fee_cents = 0
    fee_cents = max(0, min(fee_cents, gross_cents - 1))
    pending = {
        "id": str(uuid.uuid4()), "form_id": doc["id"], "owner_id": doc["owner_id"], "form_key": form,
        "values": clean, "amount": amt, "currency": cur, "ip": ip[:60],
        "status": "pending", "created_at": datetime.now(timezone.utc),
    }
    await db.form_pending.insert_one(pending.copy())
    base = _public_base(request)
    try:
        session = stripe.checkout.Session.create(
            mode="payment",
            line_items=[{"price_data": {
                "currency": cur.lower(),
                "product_data": {"name": (doc.get("title") or "Form payment")[:120]},
                "unit_amount": gross_cents,
            }, "quantity": 1}],
            payment_intent_data={"application_fee_amount": fee_cents, "transfer_data": {"destination": dest}},
            success_url=f"{base}/api/pub/form-unit?form={form}&paid={{CHECKOUT_SESSION_ID}}",
            cancel_url=f"{base}/api/pub/form-unit?form={form}&pay=cancel",
            metadata={"kind": "form_payment", "pending_id": pending["id"], "form_key": form},
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Couldn't start checkout: {str(e)[:140]}")
    await db.form_pending.update_one({"id": pending["id"]}, {"$set": {"session_id": session.get("id")}})
    return {"url": session.get("url")}


@router.get("/pub/form-paid", response_model=OkResultOut)
async def form_paid(session: str = Query(...)):
    """On-return confirm (belt-and-braces with the webhook): if the session is paid,
    finalize its submission."""
    from routes.payments import stripe, stripe_enabled
    if not stripe_enabled():
        return {"ok": False}
    try:
        s = stripe.checkout.Session.retrieve(session)
    except Exception:
        return {"ok": False}
    if s.get("payment_status") == "paid":
        meta = s.get("metadata") or {}
        if meta.get("kind") == "form_payment" and meta.get("pending_id"):
            await finalize_form_payment(meta["pending_id"])
            return {"ok": True}
    return {"ok": False}


_EMBED_JS = """(function(){
  var s=document.currentScript;
  var form="__FORM__";
  function attr(n){return s&&s.getAttribute(n);}
  var w=attr("data-width")||"100%";
  var h=attr("data-height")||"560";
  var qs="form="+encodeURIComponent(form);
  ["theme","accent","bg","radius","redirect"].forEach(function(k){
    var v=attr("data-"+k); if(v) qs+="&"+k+"="+encodeURIComponent(v);
  });
  if(attr("data-hide-title")) qs+="&hide_title=1";
  var pf=attr("data-prefill");
  if(pf){try{var o=JSON.parse(pf);Object.keys(o).forEach(function(k){qs+="&pf_"+encodeURIComponent(k)+"="+encodeURIComponent(o[k]);});}catch(e){}}
  var f=document.createElement("iframe");
  f.src="__BASE__/api/pub/form-unit?"+qs;
  f.width=w;f.height=h;f.scrolling="auto";f.style.border="0";f.style.maxWidth="100%";
  if(s&&s.parentNode)s.parentNode.insertBefore(f,s);
})();"""


@router.get("/pub/form-embed.js")
async def form_embed_js(request: Request, form: str = Query(...)):
    js = _EMBED_JS.replace("__FORM__", form).replace("__BASE__", _public_base(request))
    return Response(content=js, media_type="application/javascript")


_UNIT_HTML = """<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--acc:#00A884;--bg:#fff;--text:#0b0b0c;--muted:#5b6770;--border:#cfd6db;--field:#fff;--rad:10px}
  html,body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
  .wrap{max-width:560px;margin:0 auto;padding:16px}
  h2{margin:0 0 4px;font-size:20px}
  p.desc{margin:0 0 14px;color:var(--muted);font-size:14px}
  label{display:block;font-size:13px;font-weight:600;margin:12px 0 5px}
  .req{color:#f15c6d}
  input,textarea,select{width:100%;box-sizing:border-box;border:1px solid var(--border);border-radius:var(--rad);padding:10px 12px;font-size:14px;font-family:inherit;background:var(--field);color:var(--text)}
  textarea{min-height:96px;resize:vertical}
  .opt{display:flex;align-items:center;gap:8px;font-weight:400;margin:6px 0}
  .opt input{width:auto}
  .sigwrap{position:relative}
  .sig{width:100%;height:150px;border:1px solid var(--border);border-radius:var(--rad);background:var(--field);touch-action:none;display:block;cursor:crosshair}
  .sigclear{position:absolute;top:8px;right:8px;width:auto;margin:0;background:transparent;color:var(--muted);font-size:12px;font-weight:600;padding:4px 9px;border:1px solid var(--border);border-radius:8px}
  .sigtabs{display:flex;gap:6px;margin-bottom:8px}
  .sigtab{width:auto;margin:0;background:var(--field);color:var(--muted);border:1px solid var(--border);font-size:13px;font-weight:700;padding:6px 16px;border-radius:999px;cursor:pointer}
  .sigtab.on{background:var(--acc);color:#fff;border-color:var(--acc)}
  .sigtype{font-style:italic;font-size:18px}
  .photo{display:flex;align-items:center;gap:12px}
  .photo input[type=file]{display:none}
  .photobtn{width:auto;margin:0;background:var(--field);color:var(--text);border:1px solid var(--border);font-size:14px;font-weight:600;padding:10px 14px;border-radius:var(--rad);cursor:pointer}
  .photoprev{width:64px;height:64px;border-radius:8px;object-fit:cover;border:1px solid var(--border);display:none}
  .consent{border:1px solid var(--border);border-radius:var(--rad);background:var(--field);max-height:170px;overflow:auto;padding:12px;font-size:13px;line-height:1.5;white-space:pre-wrap;margin-bottom:8px}
  .prog{height:5px;background:var(--border);border-radius:3px;overflow:hidden;margin:2px 0 16px}
  .prog>span{display:block;height:100%;width:0;background:var(--acc);transition:width .25s ease}
  .addrwrap{position:relative}
  .addrsug{position:absolute;left:0;right:0;top:100%;background:var(--field);border:1px solid var(--border);border-top:0;border-radius:0 0 var(--rad) var(--rad);z-index:5;max-height:220px;overflow:auto}
  .addrsug .item{padding:10px 12px;cursor:pointer;font-size:14px;border-top:1px solid var(--border)}
  h3.sec{font-size:16px;font-weight:800;margin:22px 0 2px;border-top:1px solid var(--border);padding-top:16px}
  .payamt{font-size:22px;font-weight:800;color:var(--acc)}
  .rating{display:flex;gap:6px}
  .rating .star{font-size:30px;line-height:1;color:var(--border);cursor:pointer;user-select:none}
  .rating .star.on{color:var(--acc)}
  button{margin-top:16px;width:100%;background:var(--acc);color:#fff;border:0;border-radius:var(--rad);padding:12px;font-size:15px;font-weight:700;cursor:pointer}
  button:disabled{opacity:.6}
  .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  .msg{padding:14px;border-radius:var(--rad);font-size:14px;text-align:center}
  .ok{background:rgba(0,168,132,0.14);color:var(--acc)}
  .err{background:rgba(241,92,109,0.14);color:#f15c6d;margin-top:10px}
</style></head><body><div class="wrap">
<div id="root"><p class="desc">Loading…</p></div>
</div>
<script>
(function(){
  var FORM="__FORM__", BASE="__BASE__", CFG=__CONFIG__;
  var rs=document.documentElement.style;
  rs.setProperty('--acc',CFG.accent);rs.setProperty('--bg',CFG.bg);rs.setProperty('--text',CFG.text);
  rs.setProperty('--muted',CFG.muted);rs.setProperty('--border',CFG.border);rs.setProperty('--field',CFG.fieldBg);
  rs.setProperty('--rad',CFG.radius+'px');
  var root=document.getElementById("root");
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}
  // Returning from Stripe Checkout: confirm + thank-you, or note a cancellation.
  var Q=new URLSearchParams(location.search);
  if(Q.get('paid')){root.innerHTML='<div class="msg ok">Confirming your payment…</div>';fetch(BASE+"/api/pub/form-paid?session="+encodeURIComponent(Q.get('paid'))).then(function(){root.innerHTML='<div class="msg ok">Thanks! Your payment was received and your response submitted.</div>';}).catch(function(){root.innerHTML='<div class="msg ok">Thanks! Your response was submitted.</div>';});return;}
  fetch(BASE+"/api/pub/form?form="+encodeURIComponent(FORM)).then(function(r){return r.json()}).then(function(f){
    if(!f||!f.fields){root.innerHTML='<div class="msg err">This form is unavailable.</div>';return;}
    var pf=CFG.prefill||{};
    var sigMode={};
    var payFld=null;(f.fields||[]).forEach(function(fl){if(fl.type==='payment')payFld=fl;});
    var h='';
    if(!CFG.hideTitle){h+='<h2>'+esc(f.title||"Form")+'</h2>';if(f.description) h+='<p class="desc">'+esc(f.description)+'</p>';}
    h+='<form id="nf"><div class="hp"><label>Leave this empty<input type="text" name="_hp" autocomplete="off" tabindex="-1"></label></div>';
    h+='<div class="prog"><span id="pbar"></span></div>';
    (f.fields||[]).forEach(function(fl){
      var t=fl.type;
      if(t==='heading'){h+='<h3 class="sec">'+esc(fl.label)+'</h3>';return;}
      var req=fl.required?' <span class="req">*</span>':'';
      var pv=pf[fl.id]!=null?String(pf[fl.id]):"";
      h+='<label>'+esc(fl.label)+req+'</label>';
      if(t==='textarea'){h+='<textarea data-fid="'+esc(fl.id)+'" placeholder="'+esc(fl.placeholder||"")+'"'+(fl.required?' required':'')+'>'+esc(pv)+'</textarea>';}
      else if(t==='time'||t==='url'){var ut=(t==='url')?'url':'time';h+='<input type="'+ut+'" data-fid="'+esc(fl.id)+'" placeholder="'+esc(fl.placeholder||"")+'" value="'+esc(pv)+'"'+(fl.required?' required':'')+'>';}
      else if(t==='password'){h+='<input type="password" data-fid="'+esc(fl.id)+'" placeholder="'+esc(fl.placeholder||"")+'" autocomplete="new-password"'+(fl.required?' required':'')+'>';}
      else if(t==='address'){h+='<div class="addrwrap"><input type="text" data-fid="'+esc(fl.id)+'" data-addr="'+esc(fl.id)+'" autocomplete="off" placeholder="'+esc(fl.placeholder||"Start typing an address")+'" value="'+esc(pv)+'"'+(fl.required?' required':'')+'><div class="addrsug" data-sug="'+esc(fl.id)+'"></div></div>';}
      else if(t==='rating'){h+='<div class="rating" data-rating="'+esc(fl.id)+'">';for(var s=1;s<=5;s++){h+='<span class="star" data-val="'+s+'">\\u2605</span>';}h+='</div>';}
      else if(t==='payment'){if(fl.amount_open){h+='<input type="number" min="0.5" step="0.01" data-fid="'+esc(fl.id)+'" placeholder="Amount in '+esc(fl.currency||"USD")+'"'+(fl.required?' required':'')+'>';}else{h+='<div class="payamt">'+esc(fl.currency||"USD")+' '+esc(Number(fl.amount||0).toFixed(2))+'</div>';}}
      else if(t==='select'){h+='<select data-fid="'+esc(fl.id)+'"'+(fl.required?' required':'')+'><option value="">Choose…</option>';(fl.options||[]).forEach(function(o){h+='<option'+(o===pv?' selected':'')+'>'+esc(o)+'</option>';});h+='</select>';}
      else if(t==='radio'||t==='checkbox'){(fl.options||[]).forEach(function(o){var ck=(t==='radio'?o===pv:String(pv).split(",").indexOf(o)>=0)?' checked':'';h+='<label class="opt"><input type="'+t+'" name="'+esc(fl.id)+'" value="'+esc(o)+'"'+ck+'>'+esc(o)+'</label>';});}
      else if(t==='signature'){h+='<div class="sigtabs"><button type="button" class="sigtab on" data-sigmode="'+esc(fl.id)+'" data-m="draw">Draw</button><button type="button" class="sigtab" data-sigmode="'+esc(fl.id)+'" data-m="type">Type</button></div><div class="sigwrap" data-sigdraw="'+esc(fl.id)+'"><canvas class="sig" data-sig="'+esc(fl.id)+'"></canvas><button type="button" class="sigclear" data-sigclear="'+esc(fl.id)+'">Clear</button></div><input class="sigtype" data-sigtype="'+esc(fl.id)+'" type="text" placeholder="Type your full name" style="display:none">';}
      else if(t==='photo'){h+='<div class="photo"><label class="photobtn" for="ph_'+esc(fl.id)+'">Take or upload photo</label><input id="ph_'+esc(fl.id)+'" type="file" accept="image/*" data-photo="'+esc(fl.id)+'"><img class="photoprev" data-prev="'+esc(fl.id)+'"></div>';}
      else if(t==='consent'){h+='<div class="consent">'+esc(fl.text||"I agree to the terms above.")+'</div><label class="opt"><input type="checkbox" data-consent="'+esc(fl.id)+'"'+(fl.required?' required':'')+'> I agree</label>';}
      else {var it=(t==='email'||t==='number'||t==='date')?t:(t==='phone'?'tel':'text');h+='<input type="'+it+'" data-fid="'+esc(fl.id)+'" placeholder="'+esc(fl.placeholder||"")+'" value="'+esc(pv)+'"'+(fl.required?' required':'')+'>';}
    });
    var btnLabel=payFld?(payFld.amount_open?'Continue to payment':('Pay '+(payFld.currency||"USD")+' '+Number(payFld.amount||0).toFixed(2))):(f.submit_label||"Submit");
    h+='<button type="submit">'+esc(btnLabel)+'</button><div id="err" class="err" style="display:none"></div></form>';
    root.innerHTML=h;
    var form=document.getElementById("nf");
    // Completion progress bar.
    function fieldFilled(fl){
      if(fl.type==='checkbox'){return form.querySelectorAll('input[name="'+fl.id+'"]:checked').length>0;}
      if(fl.type==='radio'){return !!form.querySelector('input[name="'+fl.id+'"]:checked');}
      if(fl.type==='signature'){if((sigMode[fl.id]||'draw')==='type'){var ti=form.querySelector('[data-sigtype="'+fl.id+'"]');return !!(ti&&ti.value.trim());}var sc=form.querySelector('canvas[data-sig="'+fl.id+'"]');return !!(sc&&sc.__dirty&&sc.__dirty());}
      if(fl.type==='photo'){var pi=form.querySelector('input[data-photo="'+fl.id+'"]');return !!(pi&&pi.__data);}
      if(fl.type==='consent'){var cc=form.querySelector('input[data-consent="'+fl.id+'"]');return !!(cc&&cc.checked);}
      if(fl.type==='rating'){var rt=form.querySelector('.rating[data-rating="'+fl.id+'"]');return !!(rt&&rt.__val);}
      var el=form.querySelector('[data-fid="'+fl.id+'"]');return !!(el&&String(el.value).trim());
    }
    function updateProgress(){var n=0,tot=(f.fields||[]).length||1;(f.fields||[]).forEach(function(fl){if(fieldFilled(fl))n++;});var pb=document.getElementById('pbar');if(pb)pb.style.width=Math.round(n/tot*100)+'%';}
    // Wire up any signature canvases (mouse + touch drawing).
    form.querySelectorAll('canvas[data-sig]').forEach(function(cv){
      var ctx=cv.getContext('2d'); var r=cv.getBoundingClientRect();
      cv.width=Math.max(1,Math.floor(r.width)); cv.height=150;
      ctx.lineWidth=2.2; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.strokeStyle=CFG.text;
      var drawing=false, dirty=false;
      function pos(e){var b=cv.getBoundingClientRect();var t=(e.touches&&e.touches[0])||e;return {x:t.clientX-b.left,y:t.clientY-b.top};}
      function down(e){drawing=true;dirty=true;var p=pos(e);ctx.beginPath();ctx.moveTo(p.x,p.y);e.preventDefault();}
      function mv(e){if(!drawing)return;var p=pos(e);ctx.lineTo(p.x,p.y);ctx.stroke();e.preventDefault();}
      function up(){drawing=false;updateProgress();}
      cv.addEventListener('mousedown',down);cv.addEventListener('mousemove',mv);window.addEventListener('mouseup',up);
      cv.addEventListener('touchstart',down,{passive:false});cv.addEventListener('touchmove',mv,{passive:false});cv.addEventListener('touchend',up);
      cv.__dirty=function(){return dirty;};cv.__clear=function(){ctx.clearRect(0,0,cv.width,cv.height);dirty=false;updateProgress();};
    });
    form.querySelectorAll('[data-sigclear]').forEach(function(b){
      b.addEventListener('click',function(e){e.preventDefault();var cv=form.querySelector('canvas[data-sig="'+b.getAttribute('data-sigclear')+'"]');if(cv&&cv.__clear)cv.__clear();});
    });
    // Wire up photo inputs (take or upload → data URL + preview).
    form.querySelectorAll('input[data-photo]').forEach(function(inp){
      inp.addEventListener('change',function(){
        var file=inp.files&&inp.files[0]; if(!file)return;
        var rd=new FileReader();
        rd.onload=function(){inp.__data=rd.result;var pv=form.querySelector('img[data-prev="'+inp.getAttribute('data-photo')+'"]');if(pv){pv.src=rd.result;pv.style.display='block';}updateProgress();};
        rd.readAsDataURL(file);
      });
    });
    // Wire up address autocomplete (debounced; proxied through /pub/geocode).
    form.querySelectorAll('input[data-addr]').forEach(function(inp){
      var box=form.querySelector('[data-sug="'+inp.getAttribute('data-addr')+'"]');var tmr;
      inp.addEventListener('input',function(){
        clearTimeout(tmr);var q=inp.value.trim();if(q.length<3){if(box)box.innerHTML='';return;}
        tmr=setTimeout(function(){
          fetch(BASE+"/api/pub/geocode?q="+encodeURIComponent(q)).then(function(r){return r.json()}).then(function(j){
            if(!box)return;box.innerHTML='';(j.results||[]).forEach(function(it){
              var d=document.createElement('div');d.className='item';d.textContent=it.full_address||it.name;
              d.addEventListener('mousedown',function(e){e.preventDefault();inp.value=it.full_address||it.name;box.innerHTML='';updateProgress();});
              box.appendChild(d);
            });
          }).catch(function(){});
        },280);
      });
      inp.addEventListener('blur',function(){setTimeout(function(){if(box)box.innerHTML='';},160);});
    });
    // Wire up signature Draw/Type tabs.
    form.querySelectorAll('.sigtab').forEach(function(b){
      b.addEventListener('click',function(){
        var id=b.getAttribute('data-sigmode'),m=b.getAttribute('data-m');sigMode[id]=m;
        form.querySelectorAll('.sigtab[data-sigmode="'+id+'"]').forEach(function(x){x.className='sigtab'+(x.getAttribute('data-m')===m?' on':'');});
        var dw=form.querySelector('[data-sigdraw="'+id+'"]'),ty=form.querySelector('[data-sigtype="'+id+'"]');
        if(dw)dw.style.display=(m==='draw')?'block':'none';
        if(ty)ty.style.display=(m==='type')?'block':'none';
        updateProgress();
      });
    });
    // Wire up rating stars.
    form.querySelectorAll('.rating').forEach(function(rt){
      var stars=rt.querySelectorAll('.star');
      stars.forEach(function(st){st.addEventListener('click',function(){var v=parseInt(st.getAttribute('data-val'),10);rt.__val=String(v);stars.forEach(function(s2){s2.className='star'+(parseInt(s2.getAttribute('data-val'),10)<=v?' on':'');});updateProgress();});});
    });
    if(Q.get('pay')==='cancel'){var ec=document.getElementById('err');if(ec){ec.style.display='block';ec.textContent='Payment cancelled — you can try again.';}}
    form.addEventListener('input',updateProgress);
    form.addEventListener('change',updateProgress);
    updateProgress();
    form.addEventListener("submit",function(e){
      e.preventDefault();
      var btn=form.querySelector("button"); btn.disabled=true;
      var vals={};
      (f.fields||[]).forEach(function(fl){
        if(fl.type==='checkbox'){var arr=[];form.querySelectorAll('input[name="'+fl.id+'"]:checked').forEach(function(c){arr.push(c.value)});vals[fl.id]=arr;}
        else if(fl.type==='radio'){var c=form.querySelector('input[name="'+fl.id+'"]:checked');vals[fl.id]=c?c.value:"";}
        else if(fl.type==='signature'){if((sigMode[fl.id]||'draw')==='type'){var ti=form.querySelector('[data-sigtype="'+fl.id+'"]');vals[fl.id]=ti?ti.value:"";}else{var sc=form.querySelector('canvas[data-sig="'+fl.id+'"]');vals[fl.id]=(sc&&sc.__dirty&&sc.__dirty())?sc.toDataURL('image/png'):"";}}
        else if(fl.type==='photo'){var pi=form.querySelector('input[data-photo="'+fl.id+'"]');vals[fl.id]=(pi&&pi.__data)||"";}
        else if(fl.type==='consent'){var cc=form.querySelector('input[data-consent="'+fl.id+'"]');vals[fl.id]=(cc&&cc.checked)?"I agree":"";}
        else if(fl.type==='rating'){var rt=form.querySelector('.rating[data-rating="'+fl.id+'"]');vals[fl.id]=(rt&&rt.__val)||"";}
        else {var el=form.querySelector('[data-fid="'+fl.id+'"]');vals[fl.id]=el?el.value:"";}
      });
      var hp=form.querySelector('input[name="_hp"]');
      if(payFld){
        fetch(BASE+"/api/pub/form-checkout?form="+encodeURIComponent(FORM),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({values:vals,hp:hp?hp.value:""})})
          .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
          .then(function(res){if(res.ok&&res.j&&res.j.url){window.location.href=res.j.url;return;}var e3=document.getElementById("err");e3.style.display="block";e3.textContent=(res.j&&res.j.detail)||"Couldn\\'t start checkout.";btn.disabled=false;})
          .catch(function(){var e3=document.getElementById("err");e3.style.display="block";e3.textContent="Network error. Try again.";btn.disabled=false;});
        return;
      }
      fetch(BASE+"/api/pub/form-submit?form="+encodeURIComponent(FORM),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({values:vals,hp:hp?hp.value:""})})
        .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
        .then(function(res){
          if(res.ok&&res.j&&res.j.ok){
            if(CFG.redirect){window.location.href=CFG.redirect;return;}
            root.innerHTML='<div class="msg ok">Thanks! Your response was submitted.</div>';
          }
          else{var e2=document.getElementById("err");e2.style.display="block";e2.textContent=(res.j&&res.j.detail)||"Couldn\\'t submit. Try again.";btn.disabled=false;}
        }).catch(function(){var e2=document.getElementById("err");e2.style.display="block";e2.textContent="Network error. Try again.";btn.disabled=false;});
    });
  }).catch(function(){root.innerHTML='<div class="msg err">This form is unavailable.</div>';});
})();
</script></body></html>"""


@router.get("/pub/form-unit", response_class=HTMLResponse)
async def form_unit(
    request: Request,
    form: str = Query(...),
    theme: str = Query("light"),
    accent: Optional[str] = Query(None),
    bg: Optional[str] = Query(None),
    radius: Optional[str] = Query(None),
    hide_title: Optional[str] = Query(None),
    redirect: Optional[str] = Query(None),
):
    """Self-contained, embeddable form page. Look & behaviour are customizable via
    query params (theme, accent, bg, radius, hide_title, redirect) and pre-fill via
    `pf_<field_id>=value`."""
    prefill = {k[3:]: v for k, v in request.query_params.items() if k.startswith("pf_")}
    cfg = _embed_config(theme, accent, bg, radius, hide_title, redirect, prefill)
    # Safe to drop inside a <script> tag: escape the chars that could close it.
    cfg_js = (
        json.dumps(cfg)
        .replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    )
    page = (
        _UNIT_HTML
        .replace("__FORM__", html.escape(form))
        .replace("__BASE__", _public_base(request))
        .replace("__CONFIG__", cfg_js)
    )
    return HTMLResponse(content=page, headers={"X-Frame-Options": "ALLOWALL"})
