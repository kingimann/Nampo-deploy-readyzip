"""Custom forms — build forms in-app, use them around the site, and let
developers embed them on their own websites (Contact-Form-7 style).

An owner creates a form (gets a public `form_key`), drops in a snippet, and we
serve a self-contained form into an iframe. Submissions are stored and the owner
is notified (in-app + email). Public endpoints under `/pub/form*` take no auth —
the `form_key` identifies the form. Spam is curbed with a hidden honeypot field
and a lightweight per-IP rate limit.
"""
import html
import time
import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, Response
from pydantic import BaseModel

from core import db, get_current_user

router = APIRouter()

FIELD_TYPES = {"text", "email", "phone", "number", "textarea", "select", "checkbox", "radio", "date"}
MAX_FIELDS = 40
MAX_VALUE_LEN = 5000
MAX_TITLE = 120

# Lightweight in-memory rate limit for the public submit endpoint (single
# instance; resets on restart). Keyed by (form_key, ip).
_RATE: dict = {}
RATE_MAX = 5
RATE_WINDOW = 60.0


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


class FormCreate(BaseModel):
    title: str
    description: Optional[str] = None
    submit_label: Optional[str] = None
    fields: List[FormField] = []


class FormSubmit(BaseModel):
    values: dict = {}
    hp: Optional[str] = None                  # honeypot — must be empty


def _clean_fields(fields: List[FormField]) -> list:
    out = []
    for i, f in enumerate((fields or [])[:MAX_FIELDS]):
        t = (f.type or "text").strip().lower()
        if t not in FIELD_TYPES:
            t = "text"
        opts = None
        if t in ("select", "radio", "checkbox"):
            opts = [str(o).strip()[:120] for o in (f.options or []) if str(o).strip()][:30] or ["Option 1"]
        out.append({
            "id": (f.id or f"f{i + 1}").strip()[:40] or f"f{i + 1}",
            "type": t,
            "label": (f.label or "").strip()[:120] or f"Field {i + 1}",
            "required": bool(f.required),
            "placeholder": (f.placeholder or "").strip()[:160] or None,
            "options": opts,
        })
    return out


def _form_view(f: dict) -> dict:
    return {
        "id": f["id"], "owner_id": f.get("owner_id"), "form_key": f.get("form_key"),
        "title": f.get("title"), "description": f.get("description"),
        "submit_label": f.get("submit_label") or "Submit",
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
@router.post("/forms")
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
        "fields": _clean_fields(body.fields),
        "submissions": 0,
        "created_at": datetime.now(timezone.utc),
    }
    await db.forms.insert_one(doc.copy())
    return _form_view(doc)


@router.get("/forms")
async def list_forms(authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    rows = await db.forms.find({"owner_id": user["user_id"]}, {"_id": 0}).sort("created_at", -1).limit(100).to_list(100)
    return {"forms": [_form_view(r) for r in rows]}


@router.get("/forms/{form_id}")
async def get_form(form_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.forms.find_one({"id": form_id, "owner_id": user["user_id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Form not found")
    return _form_view(doc)


@router.post("/forms/{form_id}")
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
        "fields": _clean_fields(body.fields),
    }
    await db.forms.update_one({"id": form_id}, {"$set": updates})
    doc.update(updates)
    return _form_view(doc)


@router.delete("/forms/{form_id}")
async def delete_form(form_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    res = await db.forms.delete_one({"id": form_id, "owner_id": user["user_id"]})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Form not found")
    await db.form_submissions.delete_many({"form_id": form_id})
    return {"ok": True}


@router.get("/forms/{form_id}/submissions")
async def list_submissions(form_id: str, limit: int = Query(50), offset: int = Query(0), authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    form = await db.forms.find_one({"id": form_id, "owner_id": user["user_id"]}, {"_id": 0})
    if not form:
        raise HTTPException(status_code=404, detail="Form not found")
    lim = max(1, min(int(limit or 50), 100))
    rows = await db.form_submissions.find({"form_id": form_id}, {"_id": 0}).sort("submitted_at", -1).skip(max(0, int(offset or 0))).limit(lim).to_list(lim)
    total = await db.form_submissions.count_documents({"form_id": form_id})
    return {"submissions": rows, "total": total, "fields": form.get("fields") or []}


# ── Public render + submit (no auth — form_key identifies the form) ───────────
@router.get("/pub/form")
async def public_form(form: str = Query(...)):
    doc = await db.forms.find_one({"form_key": form}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Form not found")
    return _public_form_view(doc)


@router.post("/pub/form-submit")
async def public_submit(request: Request, body: FormSubmit, form: str = Query(...)):
    doc = await db.forms.find_one({"form_key": form}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Form not found")
    # Honeypot: a bot filled the hidden field — accept silently, store nothing.
    if (body.hp or "").strip():
        return {"ok": True}
    ip = _client_ip(request)
    if not _rate_ok(form, ip):
        raise HTTPException(status_code=429, detail="Too many submissions — wait a minute and try again.")
    fields = doc.get("fields") or []
    by_id = {f["id"]: f for f in fields}
    values = body.values if isinstance(body.values, dict) else {}
    clean: dict = {}
    for f in fields:
        raw = values.get(f["id"])
        val = (", ".join(str(x) for x in raw) if isinstance(raw, list) else ("" if raw is None else str(raw)))[:MAX_VALUE_LEN]
        if f.get("required") and not val.strip():
            raise HTTPException(status_code=400, detail=f"{f.get('label') or 'A field'} is required.")
        clean[f["id"]] = val
    sub = {
        "id": str(uuid.uuid4()),
        "form_id": doc["id"], "owner_id": doc["owner_id"],
        "values": clean, "ip": ip[:60],
        "submitted_at": datetime.now(timezone.utc),
    }
    await db.form_submissions.insert_one(sub.copy())
    await db.forms.update_one({"id": doc["id"]}, {"$inc": {"submissions": 1}})
    try:
        from routes.notifications import emit_notification
        await emit_notification(user_id=doc["owner_id"], actor_id=None, ntype="form",
                                message=f"New submission on “{doc.get('title')}”.")
    except Exception:
        pass
    try:
        owner = await db.users.find_one({"user_id": doc["owner_id"]}, {"_id": 0, "email": 1})
        if owner and owner.get("email"):
            from services.email import send_email, email_enabled
            if email_enabled():
                lines = "\n".join(f"- {by_id.get(k, {}).get('label', k)}: {v}" for k, v in clean.items())
                send_email(owner["email"], f"New submission: {doc.get('title')}",
                           f"You received a new form submission:\n\n{lines}")
    except Exception:
        pass
    return {"ok": True}


_EMBED_JS = """(function(){
  var s=document.currentScript;
  var form="__FORM__";
  var w=(s&&s.getAttribute("data-width"))||"100%";
  var h=(s&&s.getAttribute("data-height"))||"560";
  var f=document.createElement("iframe");
  f.src="__BASE__/api/pub/form-unit?form="+encodeURIComponent(form);
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
  html,body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#fff;color:#0b0b0c}
  .wrap{max-width:560px;margin:0 auto;padding:16px}
  h2{margin:0 0 4px;font-size:20px}
  p.desc{margin:0 0 14px;color:#5b6770;font-size:14px}
  label{display:block;font-size:13px;font-weight:600;margin:12px 0 5px}
  .req{color:#d92d20}
  input,textarea,select{width:100%;box-sizing:border-box;border:1px solid #cfd6db;border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit}
  textarea{min-height:96px;resize:vertical}
  .opt{display:flex;align-items:center;gap:8px;font-weight:400;margin:6px 0}
  .opt input{width:auto}
  button{margin-top:16px;width:100%;background:#00A884;color:#fff;border:0;border-radius:10px;padding:12px;font-size:15px;font-weight:700;cursor:pointer}
  button:disabled{opacity:.6}
  .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
  .msg{padding:14px;border-radius:10px;font-size:14px;text-align:center}
  .ok{background:#e7f7f0;color:#0b7a59}
  .err{background:#fdecea;color:#b42318;margin-top:10px}
</style></head><body><div class="wrap">
<div id="root"><p class="desc">Loading…</p></div>
</div>
<script>
(function(){
  var FORM="__FORM__", BASE="__BASE__";
  var root=document.getElementById("root");
  function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c];});}
  fetch(BASE+"/api/pub/form?form="+encodeURIComponent(FORM)).then(function(r){return r.json()}).then(function(f){
    if(!f||!f.fields){root.innerHTML='<div class="msg err">This form is unavailable.</div>';return;}
    var h='<h2>'+esc(f.title||"Form")+'</h2>';
    if(f.description) h+='<p class="desc">'+esc(f.description)+'</p>';
    h+='<form id="nf"><div class="hp"><label>Leave this empty<input type="text" name="_hp" autocomplete="off" tabindex="-1"></label></div>';
    (f.fields||[]).forEach(function(fl){
      var req=fl.required?' <span class="req">*</span>':'';
      h+='<label>'+esc(fl.label)+req+'</label>';
      var t=fl.type;
      if(t==='textarea'){h+='<textarea data-fid="'+esc(fl.id)+'" placeholder="'+esc(fl.placeholder||"")+'"'+(fl.required?' required':'')+'></textarea>';}
      else if(t==='select'){h+='<select data-fid="'+esc(fl.id)+'"'+(fl.required?' required':'')+'><option value="">Choose…</option>';(fl.options||[]).forEach(function(o){h+='<option>'+esc(o)+'</option>';});h+='</select>';}
      else if(t==='radio'||t==='checkbox'){(fl.options||[]).forEach(function(o){h+='<label class="opt"><input type="'+t+'" name="'+esc(fl.id)+'" value="'+esc(o)+'">'+esc(o)+'</label>';});}
      else {var it=(t==='email'||t==='number'||t==='date')?t:(t==='phone'?'tel':'text');h+='<input type="'+it+'" data-fid="'+esc(fl.id)+'" placeholder="'+esc(fl.placeholder||"")+'"'+(fl.required?' required':'')+'>';}
    });
    h+='<button type="submit">'+esc(f.submit_label||"Submit")+'</button><div id="err" class="err" style="display:none"></div></form>';
    root.innerHTML=h;
    var form=document.getElementById("nf");
    form.addEventListener("submit",function(e){
      e.preventDefault();
      var btn=form.querySelector("button"); btn.disabled=true;
      var vals={};
      (f.fields||[]).forEach(function(fl){
        if(fl.type==='checkbox'){var arr=[];form.querySelectorAll('input[name="'+fl.id+'"]:checked').forEach(function(c){arr.push(c.value)});vals[fl.id]=arr;}
        else if(fl.type==='radio'){var c=form.querySelector('input[name="'+fl.id+'"]:checked');vals[fl.id]=c?c.value:"";}
        else {var el=form.querySelector('[data-fid="'+fl.id+'"]');vals[fl.id]=el?el.value:"";}
      });
      var hp=form.querySelector('input[name="_hp"]');
      fetch(BASE+"/api/pub/form-submit?form="+encodeURIComponent(FORM),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({values:vals,hp:hp?hp.value:""})})
        .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j}})})
        .then(function(res){
          if(res.ok&&res.j&&res.j.ok){root.innerHTML='<div class="msg ok">Thanks! Your response was submitted.</div>';}
          else{var e2=document.getElementById("err");e2.style.display="block";e2.textContent=(res.j&&res.j.detail)||"Couldn\\'t submit. Try again.";btn.disabled=false;}
        }).catch(function(){var e2=document.getElementById("err");e2.style.display="block";e2.textContent="Network error. Try again.";btn.disabled=false;});
    });
  }).catch(function(){root.innerHTML='<div class="msg err">This form is unavailable.</div>';});
})();
</script></body></html>"""


@router.get("/pub/form-unit", response_class=HTMLResponse)
async def form_unit(request: Request, form: str = Query(...)):
    page = _UNIT_HTML.replace("__FORM__", html.escape(form)).replace("__BASE__", _public_base(request))
    return HTMLResponse(content=page, headers={"X-Frame-Options": "ALLOWALL"})
