"""A tiny in-memory stand-in for the app's Mongo-compatible `db` shim.

The backend's `db` exposes a MongoDB-style async API (`find_one`, `insert_one`,
`update_one`, `delete_one`, `find().to_list()`, `count_documents`, …) over
Postgres. These in-process feature tests don't want a real database, so they
swap `db` for a `FakeDB`: collections are plain lists of dicts and the query /
update operators the routes actually use are implemented here.

Supported query operators: equality, `$in`, `$ne`, `$gt`, `$gte`, `$lt`,
`$lte`, `$exists`. Supported update operators: `$set`, `$inc`, `$push`,
`$pull`, `$addToSet`. Extend here (with a test) when a route needs more.
"""
from typing import Any, Dict, List, Optional
import re as _re

from db import DuplicateKeyError


def _match(doc: dict, filt: dict) -> bool:
    for key, cond in (filt or {}).items():
        if key == "$or":
            if not any(_match(doc, sub) for sub in (cond or [])):
                return False
            continue
        if key == "$and":
            if not all(_match(doc, sub) for sub in (cond or [])):
                return False
            continue
        val = doc.get(key)
        if isinstance(cond, dict) and any(k.startswith("$") for k in cond):
            for op, target in cond.items():
                if op == "$in" and val not in target:
                    return False
                if op == "$nin" and val in target:
                    return False
                if op == "$ne" and val == target:
                    return False
                if op == "$gt" and not (val is not None and val > target):
                    return False
                if op == "$gte" and not (val is not None and val >= target):
                    return False
                if op == "$lt" and not (val is not None and val < target):
                    return False
                if op == "$lte" and not (val is not None and val <= target):
                    return False
                if op == "$exists" and (val is not None) != bool(target):
                    return False
                if op == "$regex":
                    if val is None or _re.search(target, str(val)) is None:
                        return False
        else:
            if val != cond:
                return False
    return True


def _set_path(doc: dict, path: str, value: Any) -> None:
    """Set a possibly-dotted key (`reactions.👍`) into nested dicts, Mongo-style."""
    parts = path.split(".")
    cur = doc
    for p in parts[:-1]:
        nxt = cur.get(p)
        if not isinstance(nxt, dict):
            nxt = {}
            cur[p] = nxt
        cur = nxt
    cur[parts[-1]] = value


def _get_path(doc: dict, path: str) -> Any:
    cur: Any = doc
    for p in path.split("."):
        if not isinstance(cur, dict):
            return None
        cur = cur.get(p)
    return cur


def _apply_update(doc: dict, update: dict, is_insert: bool = False) -> None:
    for op, fields in (update or {}).items():
        if op == "$setOnInsert":
            if is_insert:
                for k, v in fields.items():
                    _set_path(doc, k, v)
        elif op == "$set":
            for k, v in fields.items():
                _set_path(doc, k, v)
        elif op == "$inc":
            for k, v in fields.items():
                _set_path(doc, k, (_get_path(doc, k) or 0) + v)
        elif op == "$push":
            for k, v in fields.items():
                doc.setdefault(k, []).append(v)
        elif op == "$addToSet":
            for k, v in fields.items():
                arr = doc.setdefault(k, [])
                if v not in arr:
                    arr.append(v)
        elif op == "$pull":
            for k, v in fields.items():
                doc[k] = [x for x in (doc.get(k) or []) if x != v]
        elif not op.startswith("$"):
            # A replacement document (no operators).
            doc.clear()
            doc.update(update)
            return


class _Result:
    def __init__(self, n: int):
        self.deleted_count = n
        self.modified_count = n
        self.matched_count = n
        self.upserted_id = None


class _Cursor:
    def __init__(self, rows: List[dict]):
        self._rows = rows

    def sort(self, key, direction=-1):
        # key may be a field name; mirror Mongo's stable single-key sort.
        self._rows.sort(key=lambda d: (d.get(key) is None, d.get(key)),
                        reverse=(direction == -1))
        return self

    def skip(self, n):
        self._rows = self._rows[n:]
        return self

    def limit(self, n):
        self._rows = self._rows[:n]
        return self

    async def to_list(self, n=None):
        return [d.copy() for d in (self._rows if n is None else self._rows[:n])]


class _Coll:
    def __init__(self):
        self.docs: List[dict] = []
        self._unique: Optional[tuple] = None

    def ensure_unique(self, *fields: str) -> "_Coll":
        """Opt-in unique index: insert_one raises DuplicateKeyError on conflict,
        mirroring the real DB so idempotent-by-index routes can be tested."""
        self._unique = tuple(fields)
        return self

    def _conflicts(self, doc: dict) -> bool:
        if not self._unique:
            return False
        key = tuple(doc.get(f) for f in self._unique)
        return any(tuple(d.get(f) for f in self._unique) == key for d in self.docs)

    def find(self, filt: Optional[dict] = None, proj=None):
        return _Cursor([d.copy() for d in self.docs if _match(d, filt or {})])

    async def find_one(self, filt: Optional[dict] = None, proj=None, sort=None):
        rows = [d for d in self.docs if _match(d, filt or {})]
        if sort:
            key, direction = sort[0]
            rows.sort(key=lambda d: (d.get(key) is None, d.get(key)),
                      reverse=(direction == -1))
        return rows[0].copy() if rows else None

    async def insert_one(self, doc: dict):
        if self._conflicts(doc):
            raise DuplicateKeyError("duplicate key")
        self.docs.append(doc.copy())
        return _Result(1)

    async def insert_many(self, docs):
        for d in docs:
            self.docs.append(d.copy())
        return _Result(len(docs))

    async def update_one(self, filt: dict, update: dict, upsert: bool = False):
        for d in self.docs:
            if _match(d, filt):
                _apply_update(d, update)   # $setOnInsert is skipped on a match
                return _Result(1)
        if upsert:
            base = {k: v for k, v in filt.items() if not isinstance(v, dict)}
            _apply_update(base, update, is_insert=True)
            self.docs.append(base)
            res = _Result(0)
            res.matched_count = 0
            # Mirror Mongo: an insert returns a truthy upserted_id.
            res.upserted_id = base.get("id") or f"_upserted_{len(self.docs)}"
            return res
        return _Result(0)

    async def update_many(self, filt: dict, update: dict):
        n = 0
        for d in self.docs:
            if _match(d, filt):
                _apply_update(d, update)
                n += 1
        return _Result(n)

    async def delete_one(self, filt: dict):
        for i, d in enumerate(self.docs):
            if _match(d, filt):
                self.docs.pop(i)
                return _Result(1)
        return _Result(0)

    async def delete_many(self, filt: dict):
        keep = [d for d in self.docs if not _match(d, filt or {})]
        n = len(self.docs) - len(keep)
        self.docs = keep
        return _Result(n)

    async def count_documents(self, filt: Optional[dict] = None):
        return sum(1 for d in self.docs if _match(d, filt or {}))


class FakeDB:
    """Attribute access lazily creates a collection: `db.posts`, `db.users`, …"""

    def __init__(self):
        self._colls: Dict[str, _Coll] = {}

    def __getattr__(self, name: str) -> _Coll:
        colls = self.__dict__.setdefault("_colls", {})
        if name not in colls:
            colls[name] = _Coll()
        return colls[name]

    def seed(self, **collections: List[dict]) -> "FakeDB":
        """Bulk-load collections: db.seed(posts=[...], users=[...])."""
        for name, rows in collections.items():
            getattr(self, name).docs = [dict(r) for r in rows]
        return self
