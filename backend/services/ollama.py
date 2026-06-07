"""Local AI document check via Ollama (a vision model).

Used to auto-verify a roadside requester's insurance + proof of ownership: the
model confirms the docs look genuine and that the vehicle/owner are consistent
across both (and match what the user entered). Images are passed through in
memory and never persisted here.

Configure with:
  OLLAMA_HOST           e.g. http://localhost:11434  (unset → verifier disabled)
  OLLAMA_VISION_MODEL   e.g. llama3.2-vision (default)

Note: the backend is Python, so we call Ollama's HTTP API directly. The Vercel
AI SDK is a JavaScript library — a Node sidecar using it would hit this same
Ollama endpoint, so the result is identical.
"""
import datetime
import json
import os
import re
from typing import Optional

import httpx

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "").rstrip("/")
OLLAMA_VISION_MODEL = os.environ.get("OLLAMA_VISION_MODEL", "llama3.2-vision")
OLLAMA_TEXT_MODEL = os.environ.get("OLLAMA_TEXT_MODEL", "llama3.2")

_FUEL_OK = {"regular", "midgrade", "premium"}

# ── Real-vehicle reference data ──────────────────────────────────────────────
# Deterministic checks that run with OR without the AI: a recognised maker, a
# plausible year, and a recognised colour. Keys are normalised (lowercase,
# alphanumerics only) so "Mercedes-Benz", "mercedes benz" and "MercedesBenz"
# all match.
def _norm(s: Optional[str]) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


_KNOWN_MAKES = {_norm(m) for m in (
    "Acura", "Alfa Romeo", "Aston Martin", "Audi", "Bentley", "BMW", "Bugatti",
    "Buick", "Cadillac", "Chevrolet", "Chevy", "Chrysler", "Citroen", "Cupra",
    "Dacia", "Daewoo", "Daihatsu", "Datsun", "Dodge", "DS", "Eagle", "Ferrari",
    "Fiat", "Fisker", "Ford", "Genesis", "GMC", "Holden", "Honda", "Hummer",
    "Hyundai", "Infiniti", "Isuzu", "Jaguar", "Jeep", "Kia", "Koenigsegg",
    "Lada", "Lamborghini", "Lancia", "Land Rover", "Range Rover", "Lexus",
    "Lincoln", "Lotus", "Lucid", "Maserati", "Maybach", "Mazda", "McLaren",
    "Mercedes", "Mercedes-Benz", "Benz", "Mercury", "MG", "Mini", "Mitsubishi",
    "Morgan", "Nissan", "Oldsmobile", "Opel", "Pagani", "Peugeot", "Plymouth",
    "Polestar", "Pontiac", "Porsche", "Proton", "RAM", "Renault", "Rimac",
    "Rivian", "Rolls-Royce", "Saab", "Saturn", "Scion", "Seat", "Skoda",
    "Smart", "SsangYong", "Subaru", "Suzuki", "Tesla", "Toyota", "Vauxhall",
    "Volkswagen", "VW", "Volvo", "Abarth", "BYD", "Geely", "Chery", "Haval",
    "Tata", "Mahindra", "NIO", "XPeng", "Lynk & Co", "Ineos", "Alpine",
    "Caterham", "Noble", "Hennessey", "Shelby", "Wuling",
)}

# Base colour words. A colour is accepted when any word in the user's text is a
# known colour (so "metallic silver", "dark blue", "space gray" all pass), or
# the whole thing is a single known colour ("gunmetal", "burgundy").
_KNOWN_COLORS = {
    "black", "white", "gray", "grey", "silver", "red", "blue", "green",
    "yellow", "orange", "brown", "beige", "tan", "gold", "purple", "violet",
    "pink", "maroon", "burgundy", "navy", "teal", "turquoise", "cyan",
    "magenta", "bronze", "copper", "charcoal", "cream", "ivory", "champagne",
    "gunmetal", "pearl", "crimson", "scarlet", "olive", "lime", "indigo",
    "aqua", "plum", "mauve", "sand", "slate", "graphite", "platinum", "rose",
    "ruby", "sapphire", "emerald", "midnight", "pewter", "brick", "mustard",
    "khaki", "lavender", "peach", "coral", "salmon", "mint", "jade", "amber",
    "wine", "rust", "steel", "stone", "metallic", "onyx",
}

# Cars predate this, but no production motor vehicle exists before it.
_OLDEST_CAR_YEAR = 1886


def _make_is_real(make: str) -> bool:
    n = _norm(make)
    if not n:
        return True  # absence handled elsewhere
    return n in _KNOWN_MAKES


def _color_is_real(color: str) -> bool:
    c = (color or "").strip().lower()
    if not c:
        return True
    if _norm(c) in _KNOWN_COLORS:
        return True
    return any(w in _KNOWN_COLORS for w in re.findall(r"[a-z]+", c))


def _year_problem(year: str) -> Optional[str]:
    y = (year or "").strip()
    if not y:
        return None
    m = re.search(r"\d{4}", y)
    if not m:
        return f'"{y}" isn\'t a valid year — enter the model year (e.g. 2018).'
    yr = int(m.group())
    nxt = datetime.date.today().year + 1
    if yr < _OLDEST_CAR_YEAR or yr > nxt:
        return f"{yr} isn't a real model year — enter a year between {_OLDEST_CAR_YEAR} and {nxt}."
    return None


# Obvious keyboard-mash / placeholder model entries.
_MODEL_JUNK = {
    "asdf", "asdfgh", "asdfghjkl", "qwer", "qwerty", "zxcv", "zxcvbn", "test",
    "testing", "none", "na", "nil", "null", "abc", "abcd", "xxx", "xxxx",
    "aaa", "aaaa", "1234", "12345", "0000", "idk", "unknown", "vehicle", "car",
}


def _model_looks_fake(model: str) -> bool:
    """Heuristic gibberish check for the model — we can't list every model, but
    we can catch placeholder/keyboard-mash junk without rejecting real
    alphanumeric model codes (X5, CX-5, GT-R, Q7, RAV4, 911…)."""
    m = (model or "").strip()
    if not m:
        return False
    n = _norm(m)
    if not n:                                   # only symbols
        return True
    if n in _MODEL_JUNK:
        return True
    if re.search(r"(.)\1{3,}", n):              # 4+ of the same char in a row
        return True
    # A long run of letters with no vowel is gibberish; short codes are fine.
    letters = re.sub(r"[^a-z]", "", n)
    if len(letters) >= 5 and not re.search(r"[aeiouy]", letters):
        return True
    return False


def _plate_problem(plate: str) -> Optional[str]:
    """Basic licence-plate format sanity. Plate formats vary worldwide, so we
    only reject clearly-malformed entries: must be letters/numbers (spaces or
    hyphens allowed) and 2–8 characters once separators are removed."""
    p = (plate or "").strip()
    if not p:
        return None
    if not re.fullmatch(r"[A-Za-z0-9]([A-Za-z0-9 \-]*[A-Za-z0-9])?", p):
        return f'"{p}" isn\'t a valid plate — use only letters, numbers, spaces or hyphens.'
    core = re.sub(r"[ \-]", "", p)
    if not (2 <= len(core) <= 8):
        return f'"{p}" doesn\'t look like a valid licence plate — most plates are 2–8 letters and numbers.'
    return None


def _vehicle_rule_problems(year, make, model, color, plate=None) -> list:
    """Deterministic real-vehicle problems (no AI needed). Each item is
    {field, message}. Only checks fields that are actually filled in."""
    out = []
    make = (make or "").strip()
    model = (model or "").strip()
    color = (color or "").strip()
    if make and not _make_is_real(make):
        out.append({"field": "vehicle", "message": f'"{make}" isn\'t a make we recognise — enter a real vehicle manufacturer.'})
    if model and _model_looks_fake(model):
        out.append({"field": "vehicle", "message": f'"{model}" doesn\'t look like a real model — enter the vehicle\'s model.'})
    yp = _year_problem(year)
    if yp:
        out.append({"field": "vehicle", "message": yp})
    if color and not _color_is_real(color):
        out.append({"field": "vehicle_color", "message": f'"{color}" isn\'t a colour we recognise — enter a real vehicle colour.'})
    pp = _plate_problem(plate)
    if pp:
        out.append({"field": "vehicle_plate", "message": pp})
    return out


def ollama_enabled() -> bool:
    return bool(OLLAMA_HOST)


def _rule_issues(d: dict) -> list:
    """Deterministic baseline checks — always run, with or without the AI."""
    svc = (d.get("service") or "").strip().lower()
    issues: list = []

    def add(field, message):
        issues.append({"field": field, "message": message})

    if not svc:
        add("service", "Choose what you need help with.")
    if not d.get("has_location"):
        add("location", "Set your location so a helper can reach you.")
    elif not (d.get("place_name") or "").strip():
        add("location", "Add an address or landmark so the helper can find you.")
    if not (d.get("vehicle_make") or "").strip():
        add("vehicle", "Add your vehicle make so the helper can spot it.")
    if not (d.get("vehicle_model") or "").strip():
        add("vehicle", "Add your vehicle model.")
    if not (d.get("vehicle_year") or "").strip():
        add("vehicle", "Add the vehicle year.")
    if svc == "tow":
        if not (d.get("dest_name") or "").strip():
            add("dest_name", "Add where you'd like the vehicle towed.")
        if not (d.get("vehicle_plate") or "").strip():
            add("vehicle_plate", "Add your licence plate — handy for a tow.")
    if svc == "gas":
        ft = (d.get("fuel_type") or "").strip().lower()
        if ft == "diesel":
            add("fuel_type", "We don't deliver diesel — pick regular, mid-grade or premium.")
        elif ft not in _FUEL_OK:
            add("fuel_type", "Choose a fuel type (regular, mid-grade or premium).")
        if not (d.get("fuel_amount") or "").strip():
            add("fuel_amount", "Tell the driver how much gas you want.")
    return issues


async def review_form(d: dict) -> dict:
    """Check a roadside request form is filled out correctly and suggest fixes.
    Always returns the deterministic checks; the AI (when configured) adds extra
    clarity/quality suggestions plus a real-vehicle check. Shape:
    {ok, issues:[{field,message}], block}. `block` is true when the entered
    vehicle is clearly not a real make/model/year — the caller must not proceed."""
    issues = _rule_issues(d)
    make = (d.get("vehicle_make") or "").strip()
    model = (d.get("vehicle_model") or "").strip()
    # Deterministic real-vehicle checks — these always run and can block on
    # their own, so a fake make/year/colour is caught even without the AI.
    veh_problems = _vehicle_rule_problems(
        d.get("vehicle_year"), make, model, d.get("vehicle_color"), d.get("vehicle_plate"))
    seen0 = {(i.get("field"), i.get("message")) for i in issues}
    for p in veh_problems:
        if (p["field"], p["message"]) not in seen0:
            issues.append(p)
            seen0.add((p["field"], p["message"]))
    rule_block = bool(veh_problems)
    if not ollama_enabled():
        return {"ok": len(issues) == 0, "issues": issues, "block": rule_block, "source": "rules"}

    safe = {k: d.get(k) for k in (
        "service", "place_name", "dest_name", "fuel_type", "fuel_amount",
        "vehicle_year", "vehicle_make", "vehicle_model", "vehicle_color", "vehicle_plate", "note",
    )}
    prompt = (
        "You help users fill out a roadside-assistance request correctly. Given this form "
        "(JSON), list anything that is missing, inconsistent, implausible or unclear, with a "
        "short, friendly fix for each — so a helper can find them and bring the right thing. "
        "Don't invent problems with fields that look fine. Service types: tow, lockout, "
        "battery, tire, gas. Gas needs a fuel type (regular/midgrade/premium — never diesel) "
        "and an amount. A tow needs a destination.\n"
        "ALSO verify the vehicle: if a make and model are given, is it a REAL production "
        "vehicle (the model belongs to that make, and exists around that year)? Set "
        "vehicle_real to false for made-up or mismatched vehicles (e.g. 'Tesla Mustang', "
        "'Honda Xyz'). If only one of make/model is given, leave vehicle_real true.\n"
        f"Form: {json.dumps(safe)}\n"
        'Reply with ONLY JSON: {"issues":[{"field":"<name>","message":"<short fix>"}], "vehicle_real": true|false}'
    )
    ai = None
    vehicle_real = True
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(f"{OLLAMA_HOST}/api/chat", json={
                "model": OLLAMA_TEXT_MODEL, "stream": False, "format": "json",
                "options": {"temperature": 0},
                "messages": [{"role": "user", "content": prompt}],
            })
            resp.raise_for_status()
            content = ((resp.json() or {}).get("message") or {}).get("content") or ""
        parsed = json.loads(content)
        if isinstance(parsed, dict):
            ai = parsed.get("issues")
            vehicle_real = parsed.get("vehicle_real", True) is not False
    except Exception:
        ai = None

    if ai:
        seen = {(i.get("field"), i.get("message")) for i in issues}
        for it in ai:
            if not isinstance(it, dict):
                continue
            field = str(it.get("field") or "general")[:40]
            msg = str(it.get("message") or "").strip()[:200]
            if msg and (field, msg) not in seen:
                issues.append({"field": field, "message": msg})
                seen.add((field, msg))

    block = rule_block or bool(make and model and not vehicle_real)
    if (make and model and not vehicle_real) and not any("real vehicle" in (i.get("message") or "").lower() for i in issues):
        issues.append({"field": "vehicle", "message": f"“{d.get('vehicle_year') or ''} {make} {model}”".strip() + " doesn't look like a real vehicle — fix the year, make and model to continue."})
    return {"ok": len(issues) == 0, "issues": issues, "block": block, "source": "ai" if ai is not None else "rules"}


async def validate_vehicle(year: Optional[str], make: Optional[str], model: Optional[str],
                           color: Optional[str] = None, plate: Optional[str] = None) -> dict:
    """Authoritative real-vehicle check for blocking on submit. Returns
    {valid, reason}. Deterministic checks (real make, plausible year, real
    colour, sane model & plate format) always run; the AI adds a make↔model
    match check when configured. Fails open only on the AI portion — a bad
    make/year/colour/model/plate blocks even without Ollama."""
    make = (make or "").strip()
    model = (model or "").strip()
    year = (year or "").strip()
    color = (color or "").strip()
    plate = (plate or "").strip()
    # Deterministic gate first — works with or without the AI.
    problems = _vehicle_rule_problems(year, make, model, color, plate)
    if problems:
        return {"valid": False, "reason": problems[0]["message"]}
    if not (make and model) or not ollama_enabled():
        return {"valid": True, "reason": ""}
    prompt = (
        "Is this a REAL production motor vehicle that actually exists? The model must belong "
        "to the make, and should exist around the given year (a year or two off is fine).\n"
        f"Year: {year or 'unspecified'}\nMake: {make}\nModel: {model}\n"
        'Reply with ONLY JSON: {"real": true|false, "reason": "<one short sentence>"}'
    )
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(f"{OLLAMA_HOST}/api/chat", json={
                "model": OLLAMA_TEXT_MODEL, "stream": False, "format": "json",
                "options": {"temperature": 0},
                "messages": [{"role": "user", "content": prompt}],
            })
            resp.raise_for_status()
            content = ((resp.json() or {}).get("message") or {}).get("content") or ""
        parsed = json.loads(content)
    except Exception:
        return {"valid": True, "reason": ""}
    if isinstance(parsed, dict) and parsed.get("real") is False:
        return {"valid": False, "reason": str(parsed.get("reason") or "").strip()[:200]}
    return {"valid": True, "reason": ""}


def _raw_b64(s: str) -> str:
    """Ollama wants bare base64 (no `data:image/...;base64,` prefix)."""
    s = (s or "").strip()
    if s.startswith("data:") and "," in s:
        return s.split(",", 1)[1]
    return s


async def _fetch_image_b64(photo: str) -> str:
    """Ollama can only take inline base64, but captured photos may be a hosted
    URL (e.g. a Cloudinary upload). If `photo` is an http(s) URL, download it and
    return a base64 data URI; otherwise return it unchanged (and on any error)."""
    p = (photo or "").strip()
    if not (p.startswith("http://") or p.startswith("https://")):
        return p
    try:
        import base64 as _b64
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(p)
            r.raise_for_status()
            ctype = (r.headers.get("content-type") or "image/jpeg").split(";")[0].strip() or "image/jpeg"
        return f"data:{ctype};base64," + _b64.b64encode(r.content).decode("ascii")
    except Exception:
        return p


async def verify_documents(
    insurance_b64: str,
    ownership_b64: str,
    vehicle: Optional[str],
    name: Optional[str],
) -> dict:
    """Returns {"decision": "approve"|"reject"|"unavailable", "reason": str}.
    `unavailable` means the caller should fall back (e.g. manual review)."""
    if not ollama_enabled():
        # No local Ollama model — use the hosted AI verifier (Anthropic).
        from services.claude_ai import verify_documents_claude
        return await verify_documents_claude(insurance_b64, ownership_b64, vehicle, name)

    insurance_b64 = await _fetch_image_b64(insurance_b64)   # download hosted URLs to base64
    ownership_b64 = await _fetch_image_b64(ownership_b64)
    prompt = (
        "You verify members for a peer-to-peer roadside assistance app, to stop "
        "bots and fraud. Image 1 is the member's AUTO INSURANCE document. Image 2 "
        "is their PROOF OF VEHICLE OWNERSHIP (registration or title).\n"
        f"Member-entered vehicle: {vehicle or 'not provided'}\n"
        f"Member-entered name: {name or 'not provided'}\n\n"
        "Approve ONLY if: both images are legible, real documents; image 1 is auto "
        "insurance; image 2 is a vehicle registration or title; and the owner name "
        "and the vehicle are consistent across both documents (and match the "
        "member-entered details when those are provided). Reject blurry, edited, "
        "mismatched, expired, or wrong-type documents.\n"
        'Reply with ONLY JSON: {"match": true|false, "reason": "<one short sentence>"}'
    )
    payload = {
        "model": OLLAMA_VISION_MODEL,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0},
        "messages": [{
            "role": "user",
            "content": prompt,
            "images": [_raw_b64(insurance_b64), _raw_b64(ownership_b64)],
        }],
    }
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(f"{OLLAMA_HOST}/api/chat", json=payload)
            resp.raise_for_status()
            data = resp.json()
        content = ((data or {}).get("message") or {}).get("content") or ""
    except Exception as e:
        return {"decision": "unavailable", "reason": f"verifier error: {e}"[:200]}

    parsed = None
    try:
        parsed = json.loads(content)
    except Exception:
        m = re.search(r"\{.*\}", content, re.S)
        if m:
            try:
                parsed = json.loads(m.group(0))
            except Exception:
                parsed = None
    if not isinstance(parsed, dict):
        return {"decision": "unavailable", "reason": "verifier returned an unreadable response"}

    match = bool(parsed.get("match"))
    reason = str(parsed.get("reason") or "")[:300]
    return {"decision": "approve" if match else "reject", "reason": reason}


def _image_looks_blank(b64: str) -> bool:
    """Deterministic black/blank-photo guard. Decodes a thumbnail and rejects
    near-black, near-white or featureless (no-detail) images. Needs Pillow;
    if it isn't available we skip this and let the AI handle it."""
    try:
        import base64 as _b64
        import io
        from PIL import Image
    except Exception:
        return False
    try:
        raw = _b64.b64decode(_raw_b64(b64), validate=False)
        im = Image.open(io.BytesIO(raw)).convert("L")
        im.thumbnail((64, 64))
        px = list(im.getdata())
    except Exception:
        return False
    if not px:
        return False
    mean = sum(px) / len(px)
    var = sum((p - mean) ** 2 for p in px) / len(px)
    # Near-black, blown-out white, or almost no variation across the frame.
    return mean < 12 or mean > 245 or var < 25


async def verify_vehicle_photo(b64: str) -> dict:
    """Check a roadside photo actually shows a vehicle (or the part with the
    problem). Returns {"ok": bool, "reason": str}. A blank/black photo is
    rejected deterministically; the vision AI rejects unrelated photos. Fails
    open (ok) when the AI isn't configured and the image isn't obviously blank."""
    if not (b64 or "").strip():
        return {"ok": False, "reason": "No photo was captured — try again."}
    if _image_looks_blank(b64):
        return {"ok": False, "reason": "That looks like a blank or all-dark photo. Take a clear photo of your vehicle or the problem."}
    if not ollama_enabled():
        # No local Ollama model — use the hosted AI check (Anthropic). It reads
        # hosted URLs (e.g. Cloudinary) directly and fails open if unconfigured.
        from services.claude_ai import classify_vehicle_photo
        return await classify_vehicle_photo(b64)
    b64 = await _fetch_image_b64(b64)   # download hosted URLs (e.g. Cloudinary) to base64
    prompt = (
        "This is a photo from a roadside-assistance request. Does it clearly show a "
        "motor vehicle, or a part of one relevant to the problem (e.g. a flat or "
        "damaged tyre, engine bay, dead battery, a locked door/window, fuel cap)? "
        "Answer false for an unrelated subject (a person, a room, food, a screenshot, "
        "random objects) or a blank/black/too-dark image.\n"
        'Reply with ONLY JSON: {"shows_vehicle": true|false, "reason": "<one short sentence>"}'
    )
    payload = {
        "model": OLLAMA_VISION_MODEL,
        "stream": False,
        "format": "json",
        "options": {"temperature": 0},
        "messages": [{"role": "user", "content": prompt, "images": [_raw_b64(b64)]}],
    }
    try:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(f"{OLLAMA_HOST}/api/chat", json=payload)
            resp.raise_for_status()
            content = ((resp.json() or {}).get("message") or {}).get("content") or ""
        parsed = json.loads(content)
    except Exception:
        return {"ok": True, "reason": ""}   # don't block on AI hiccups
    if isinstance(parsed, dict) and parsed.get("shows_vehicle") is False:
        reason = str(parsed.get("reason") or "").strip()[:200]
        return {"ok": False, "reason": reason or "That photo doesn't look like your vehicle or the problem. Take a clear photo of the car or the issue."}
    return {"ok": True, "reason": ""}


# ── Marketplace listing moderation ──────────────────────────────────────────
_SPAM_WORDS = [
    "free money", "make money fast", "click here", "wire transfer", "western union",
    "gift card", "crypto giveaway", "double your", "investment opportunity",
    "whatsapp me", "100% guaranteed", "act now", "limited offer", "dm me to buy",
    "cash app only", "telegram", "no scam", "get rich",
]


def _listing_rule_flags(title: str, description: str, photos, dup_existing: bool = False) -> list:
    """Deterministic spam checks — run with or without the AI."""
    reasons: list = []
    title = (title or "").strip()
    desc = (description or "").strip()
    pics = [p for p in (photos or []) if isinstance(p, str) and p.strip()]
    if not pics:
        reasons.append("The listing has no photos.")
    elif len(set(pics)) < len(pics):
        reasons.append("The same photo is used more than once.")
    if dup_existing:
        reasons.append("These photos are already used in another of your listings.")
    if len(desc) < 10:
        reasons.append("The description is missing or too short.")
    low = f"{title} {desc}".lower()
    if any(w in low for w in _SPAM_WORDS):
        reasons.append("The title or description reads like spam.")
    if re.search(r"https?://|www\.", low) or re.search(r"\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b", low):
        reasons.append("Remove links and phone numbers from the title/description — use the contact fields.")
    if title and sum(1 for c in title if c.isupper()) > max(8, int(len(title) * 0.6)):
        reasons.append("The title is mostly capital letters.")
    return reasons


async def moderate_listing(title: str, description: str, photos, dup_existing: bool = False) -> dict:
    """Decide whether a marketplace listing is spam / low-quality. Returns
    {flagged: bool, reasons: [str]}. Rule checks always run; the AI (when
    configured) adds a spam/scam judgement on the title + description."""
    reasons = _listing_rule_flags(title, description, photos, dup_existing)
    if ollama_enabled():
        prompt = (
            "You moderate a peer-to-peer marketplace. Decide if this listing is spam, a scam, "
            "or an obviously low-quality placeholder. Genuine items for sale are fine — don't "
            "flag those.\n"
            f"Title: {title}\nDescription: {description}\n"
            'Reply with ONLY JSON: {"spam": true|false, "reason": "<one short sentence>"}'
        )
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(f"{OLLAMA_HOST}/api/chat", json={
                    "model": OLLAMA_TEXT_MODEL, "stream": False, "format": "json",
                    "options": {"temperature": 0},
                    "messages": [{"role": "user", "content": prompt}],
                })
                resp.raise_for_status()
                content = ((resp.json() or {}).get("message") or {}).get("content") or ""
            parsed = json.loads(content)
            if isinstance(parsed, dict) and parsed.get("spam"):
                r = str(parsed.get("reason") or "This looks like spam.").strip()[:200]
                if r and r not in reasons:
                    reasons.append(r)
        except Exception:
            pass
    else:
        # No local Ollama model — use the hosted AI (Anthropic) for the spam/scam
        # judgement. No-op when ANTHROPIC_API_KEY is also unset.
        try:
            from services.claude_ai import classify_listing_spam
            res = await classify_listing_spam(title, description)
            if res and res.get("spam"):
                r = (res.get("reason") or "This looks like spam.").strip()[:200]
                if r and r not in reasons:
                    reasons.append(r)
        except Exception:
            pass
    return {"flagged": len(reasons) > 0, "reasons": reasons}
