"""Mini games platform — users upload (Three.js) games people play in-app.

A creator uploads a game (inline HTML or a hosted URL) and integrates the small
**OkaySpace Games SDK** (`/api/pub/games/sdk.js`): a postMessage bridge giving the
game `NamiGames.ready()`, `submitScore(n)`, `getPlayer()`, and `exit()`. Score
submission goes through the host app (which holds the user's auth), never the
game itself — so games can't forge authenticated calls.

Play surface: the app loads `/api/pub/game/{id}` in a WebView (native) / iframe
(web); for inline-HTML games we inject the SDK automatically.
"""
from datetime import datetime, timezone
from typing import Optional
from xml.sax.saxutils import quoteattr
import uuid

from fastapi import APIRouter, Header, HTTPException, Request, Response
from pydantic import BaseModel

from core import db, get_current_user
from db import DuplicateKeyError

router = APIRouter()

HTML_MAX = 3_000_000      # ~3MB inline game cap (bigger games should use a URL)
TITLE_MAX = 120
DESC_MAX = 600


class GameCreate(BaseModel):
    title: str
    description: Optional[str] = ""
    url: Optional[str] = None        # hosted game URL (loads the SDK itself)
    html: Optional[str] = None       # inline game HTML (SDK auto-injected)
    thumbnail: Optional[str] = None  # data URI or URL


class ScoreSubmit(BaseModel):
    score: float


def _card(doc: dict, owner: Optional[dict] = None) -> dict:
    return {
        "id": doc["id"],
        "title": doc.get("title", "Untitled"),
        "description": doc.get("description", ""),
        "thumbnail": doc.get("thumbnail"),
        "owner_id": doc.get("owner_id"),
        "owner_name": (owner or {}).get("name") if owner else doc.get("owner_name"),
        "kind": "url" if doc.get("url") else "html",
        "plays": int(doc.get("plays", 0)),
        "created_at": doc.get("created_at"),
    }


def _public_base(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc
    return f"{proto}://{host}"


# ── Creator CRUD ─────────────────────────────────────────────────────────────
@router.post("/games")
async def create_game(body: GameCreate, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    title = (body.title or "").strip()[:TITLE_MAX]
    if not title:
        raise HTTPException(status_code=400, detail="Title is required")
    url = (body.url or "").strip()
    html = body.html or ""
    if url and (not (url.startswith("http://") or url.startswith("https://"))
                or any(c in url for c in " \t\r\n\"'<>")):
        raise HTTPException(status_code=400, detail="Game URL must be a valid http/https URL")
    if not url and not html.strip():
        raise HTTPException(status_code=400, detail="Provide a game URL or inline HTML")
    if html and len(html) > HTML_MAX:
        raise HTTPException(status_code=413, detail="Inline game too large — host it and use a URL instead")
    now = datetime.now(timezone.utc)
    doc = {
        "id": str(uuid.uuid4()),
        "owner_id": user["user_id"],
        "owner_name": user.get("name", "Someone"),
        "title": title,
        "description": (body.description or "").strip()[:DESC_MAX],
        "url": url or None,
        "html": html or None,
        "thumbnail": body.thumbnail,
        "plays": 0,
        "created_at": now,
    }
    await db.games.insert_one(doc.copy())
    return _card(doc)


@router.get("/games")
async def list_games(mine: Optional[bool] = False, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    q = {"owner_id": user["user_id"]} if mine else {}
    rows = await db.games.find(q, {"_id": 0}).sort("created_at", -1).limit(200).to_list(200)
    return {"games": [_card(r) for r in rows]}


@router.get("/games/{game_id}")
async def get_game(game_id: str, authorization: Optional[str] = Header(None)):
    await get_current_user(authorization)
    doc = await db.games.find_one({"id": game_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Game not found")
    return _card(doc)


@router.delete("/games/{game_id}")
async def delete_game(game_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    doc = await db.games.find_one({"id": game_id}, {"_id": 0, "owner_id": 1})
    if not doc:
        raise HTTPException(status_code=404, detail="Game not found")
    if doc["owner_id"] != user["user_id"] and user.get("role") not in ("admin", "mod"):
        raise HTTPException(status_code=403, detail="Not allowed")
    await db.games.delete_one({"id": game_id})
    await db.game_scores.delete_many({"game_id": game_id})
    return {"ok": True}


# ── Scores / leaderboard (host-mediated; the game never calls these directly) ──
@router.post("/games/{game_id}/score")
async def submit_score(game_id: str, body: ScoreSubmit, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    game = await db.games.find_one({"id": game_id}, {"_id": 0, "id": 1})
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    score = float(body.score or 0)
    name = user.get("name", "Player")
    key = {"game_id": game_id, "user_id": user["user_id"]}
    now = datetime.now(timezone.utc)
    # First score for this user → insert. The unique index (game_id, user_id)
    # makes this race-safe: a concurrent first submit raises DuplicateKeyError
    # and falls through to the conditional update below.
    try:
        await db.game_scores.insert_one({**key, "best": score, "name": name, "updated_at": now, "created_at": now})
        return {"ok": True, "best": score}
    except DuplicateKeyError:
        pass
    # Atomic: only raise the stored best when this score is strictly higher, so
    # two concurrent submits can't clobber a higher score with a lower one.
    await db.game_scores.update_one(
        {**key, "best": {"$lt": score}},
        {"$set": {"best": score, "name": name, "updated_at": now}},
    )
    row = await db.game_scores.find_one(key, {"_id": 0, "best": 1})
    return {"ok": True, "best": float((row or {}).get("best", score))}


@router.get("/games/{game_id}/leaderboard")
async def leaderboard(game_id: str, authorization: Optional[str] = Header(None)):
    user = await get_current_user(authorization)
    rows = await db.game_scores.find({"game_id": game_id}, {"_id": 0}).limit(500).to_list(500)
    rows.sort(key=lambda r: float(r.get("best", 0)), reverse=True)
    top = [{"name": r.get("name", "Player"), "score": float(r.get("best", 0)), "mine": r.get("user_id") == user["user_id"]} for r in rows[:50]]
    return {"leaderboard": top}


@router.post("/games/{game_id}/play")
async def record_play(game_id: str, authorization: Optional[str] = Header(None)):
    await get_current_user(authorization)
    await db.games.update_one({"id": game_id}, {"$inc": {"plays": 1}})
    return {"ok": True}


# ── Public: the SDK + the game frame (no auth — loaded inside the player) ──
THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.149.0/build/three.min.js"

SDK_JS = """
(function(){
  var pending = {};
  function send(msg){
    msg.namiGame = true;
    var s = JSON.stringify(msg);
    try { if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(s); return; } } catch(e){}
    try { if (window.parent && window.parent !== window) window.parent.postMessage(s, '*'); } catch(e){}
  }
  var NG = {
    // ── Platform bridge ──────────────────────────────────────────────
    ready: function(){ send({ type: 'ready' }); },
    submitScore: function(score){ send({ type: 'score', score: Number(score) || 0 }); },
    exit: function(){ send({ type: 'exit' }); },
    getPlayer: function(){ return new Promise(function(resolve){ pending.player = resolve; send({ type: 'getPlayer' }); }); },
    onMessage: null,
    THREE: null
  };
  window.NamiGames = NG;
  window.OkaySpace = NG;

  function handle(d){
    if (!d || !d.namiHost) return;
    if (d.type === 'player' && pending.player) { pending.player(d.player || {}); pending.player = null; }
    if (typeof NG.onMessage === 'function') NG.onMessage(d);
  }
  window.addEventListener('message', function(e){ var d; try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch(_){ return; } handle(d); });
  window.__namiHost = function(raw){ try { handle(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch(_){} };

  // ── 3D engine (Three.js bundled under the hood) ────────────────────
  // Build a whole game with the OkaySpace API — no need to touch Three.js directly.
  NG.loadThree = function(){
    return new Promise(function(resolve, reject){
      if (window.THREE) { NG.THREE = window.THREE; return resolve(window.THREE); }
      var s = document.createElement('script');
      s.src = '__THREE_CDN__';
      s.onload = function(){ NG.THREE = window.THREE; resolve(window.THREE); };
      s.onerror = function(){ reject(new Error('Failed to load 3D engine')); };
      document.head.appendChild(s);
    });
  };

  NG.create3D = function(config){
    config = config || {};
    return NG.loadThree().then(function(THREE){
      document.documentElement.style.height = '100%';
      document.body.style.margin = '0';
      document.body.style.height = '100%';
      document.body.style.overflow = 'hidden';
      var W = function(){ return window.innerWidth; }, H = function(){ return window.innerHeight; };
      var renderer = new THREE.WebGLRenderer({ antialias: true, alpha: !!config.transparent });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(W(), H());
      (config.mount || document.body).appendChild(renderer.domElement);

      var scene = new THREE.Scene();
      if (config.background != null) scene.background = new THREE.Color(config.background);
      var camera = new THREE.PerspectiveCamera(config.fov || 60, W()/H(), 0.1, 2000);
      var cp = config.cameraPosition || [0, 3, 8];
      camera.position.set(cp[0], cp[1], cp[2]);
      camera.lookAt(0, 0, 0);
      scene.add(new THREE.AmbientLight(0xffffff, 0.65));
      var dir = new THREE.DirectionalLight(0xffffff, 0.85); dir.position.set(6, 12, 8); scene.add(dir);

      var tapCbs = [], dragCbs = [], keyCbs = [], updateCbs = [];
      if (config.onUpdate) updateCbs.push(config.onUpdate);

      var raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
      var api = {
        THREE: THREE, scene: scene, camera: camera, renderer: renderer,
        add: function(o){ scene.add(o); return o; },
        remove: function(o){ scene.remove(o); return o; },
        box: function(o){ o=o||{}; var m=new THREE.Mesh(new THREE.BoxGeometry(o.w||1,o.h||1,o.d||1), new THREE.MeshStandardMaterial({color:o.color!=null?o.color:0x3b82f6})); m.position.set(o.x||0,o.y||0,o.z||0); scene.add(m); return m; },
        sphere: function(o){ o=o||{}; var m=new THREE.Mesh(new THREE.SphereGeometry(o.r||0.5,32,24), new THREE.MeshStandardMaterial({color:o.color!=null?o.color:0xf59e0b})); m.position.set(o.x||0,o.y||0,o.z||0); scene.add(m); return m; },
        ground: function(o){ o=o||{}; var m=new THREE.Mesh(new THREE.PlaneGeometry(o.size||60,o.size||60), new THREE.MeshStandardMaterial({color:o.color!=null?o.color:0x1b222b})); m.rotation.x=-Math.PI/2; m.position.y=o.y||0; scene.add(m); return m; },
        light: function(o){ o=o||{}; var l=new THREE.PointLight(o.color!=null?o.color:0xffffff,o.intensity||1,o.distance||0); l.position.set(o.x||0,o.y||6,o.z||0); scene.add(l); return l; },
        text2d: null,
        onTap: function(cb){ tapCbs.push(cb); },
        onDrag: function(cb){ dragCbs.push(cb); },
        onKey: function(cb){ keyCbs.push(cb); },
        onUpdate: function(cb){ updateCbs.push(cb); },
        // Which object (from `objects`) is under a tap, using the tap's NDC coords.
        pick: function(tap, objects){ ndc.set(tap.nx, tap.ny); raycaster.setFromCamera(ndc, camera); var hits = raycaster.intersectObjects(objects, true); return hits[0] ? hits[0].object : null; },
        // Platform shortcuts so the game only ever calls OkaySpace:
        submitScore: NG.submitScore, getPlayer: NG.getPlayer, exit: NG.exit
      };

      function tap(e){ var t=(e.touches&&e.touches[0])||e; var x=t.clientX, y=t.clientY; var info={x:x,y:y,nx:(x/W())*2-1,ny:-(y/H())*2+1}; tapCbs.forEach(function(c){ try{c(info);}catch(_){} }); return info; }
      var dragging=false, lx=0, ly=0;
      renderer.domElement.addEventListener('pointerdown', function(e){ dragging=true; var i=tap(e); lx=i.x; ly=i.y; });
      window.addEventListener('pointermove', function(e){ if(!dragging) return; var t=(e.touches&&e.touches[0])||e; var info={dx:t.clientX-lx, dy:t.clientY-ly, x:t.clientX, y:t.clientY}; dragCbs.forEach(function(c){ try{c(info);}catch(_){} }); lx=t.clientX; ly=t.clientY; });
      window.addEventListener('pointerup', function(){ dragging=false; });
      window.addEventListener('keydown', function(e){ keyCbs.forEach(function(c){ try{c(e.key, true, e);}catch(_){} }); });
      window.addEventListener('keyup', function(e){ keyCbs.forEach(function(c){ try{c(e.key, false, e);}catch(_){} }); });
      window.addEventListener('resize', function(){ camera.aspect=W()/H(); camera.updateProjectionMatrix(); renderer.setSize(W(), H()); });

      var clock = new THREE.Clock();
      (function loop(){ requestAnimationFrame(loop); var dt=clock.getDelta(); updateCbs.forEach(function(c){ try{c(dt, api);}catch(_){} }); renderer.render(scene, camera); })();

      NG.ready();
      if (config.onReady) { try { config.onReady(api); } catch(_){} }
      return api;
    });
  };
})();
""".replace("__THREE_CDN__", THREE_CDN)


@router.get("/pub/games/sdk.js")
async def games_sdk() -> Response:
    return Response(content=SDK_JS, media_type="application/javascript", headers={
        "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*",
    })


@router.get("/pub/game/{game_id}")
async def play_game(game_id: str, request: Request) -> Response:
    doc = await db.games.find_one({"id": game_id}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="Game not found")
    base = _public_base(request)
    sdk_tag = f'<script src="{base}/api/pub/games/sdk.js"></script>'
    if doc.get("html"):
        html = doc["html"]
        # Inject the SDK right after <head> (or at the top) so NamiGames exists.
        if "<head>" in html:
            html = html.replace("<head>", "<head>" + sdk_tag, 1)
        elif "<html" in html:
            html = html.replace(">", ">" + sdk_tag, 1)
        else:
            html = sdk_tag + html
        body = html
    else:
        # Hosted URL: load it in a full-screen iframe; the game includes the SDK.
        # quoteattr() wraps the URL in quotes and escapes them, so a crafted
        # URL can't break out of the src attribute to inject markup/handlers.
        src = quoteattr(doc["url"])
        body = (
            "<!doctype html><html><head><meta charset='utf-8'>"
            "<meta name='viewport' content='width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no'>"
            "<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{border:0;width:100%;height:100%}</style>"
            f"{sdk_tag}</head><body>"
            f"<iframe src={src} allow='fullscreen; gamepad; accelerometer; gyroscope'></iframe>"
            "</body></html>"
        )
    return Response(content=body, media_type="text/html", headers={
        "Access-Control-Allow-Origin": "*", "X-Frame-Options": "ALLOWALL",
    })
