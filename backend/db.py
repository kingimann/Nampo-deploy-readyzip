"""PostgreSQL-backed MongoDB-compatible async database wrapper.

Every collection becomes a table with a single JSONB `doc` column.
The API mirrors motor (Motor AsyncIO) so all route code stays unchanged:
  db.collection.find_one(filter) / .find(filter).sort().limit().to_list(n)
  db.collection.insert_one(doc)
  db.collection.update_one(filter, update, upsert=False)
  db.collection.update_many(filter, update)
  db.collection.delete_one(filter) / .delete_many(filter)
  db.collection.count_documents(filter)
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Tuple

import asyncpg

logger = logging.getLogger("db")

# ──────────────────────────────────────────────
# Exception that replaces pymongo DuplicateKeyError
# ──────────────────────────────────────────────

class DuplicateKeyError(Exception):
    """Raised when an INSERT violates a unique index."""


# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────

_ISO_DT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}")

# Fields known to hold JSON arrays — uses @> containment in queries.
_ARRAY_FIELDS = {
    "participant_ids", "deleted_by", "hashtags", "place_ids",
    "pinned_post_ids", "auth_providers", "member_ids", "badge_ids",
    # Developer-webhook subscriptions: filtering by a single event must use
    # array containment, not text equality (otherwise no webhook ever matches).
    "events",
}

# Fields known to hold datetimes — cast to ::timestamptz in comparisons.
_DATE_FIELDS = {
    "created_at", "updated_at", "expires_at", "last_message_at",
    "locked_until", "decided_at", "joined_at", "viewed_at",
    "fetched_at", "ends_at", "edited_at",
}

# Fields known to hold numbers — sorted numerically, not as text. Without this a
# JSONB text sort makes "9" > "10" (breaks roadside call numbers, top-post and
# price rankings, leaderboards, etc.).
_NUMERIC_FIELDS = {
    "call_number", "likes_count", "dislikes_count", "comments_count",
    "replies_count", "reposts_count", "views_count", "reactions_total",
    "bookmarks_count", "shares_count", "price", "amount", "best", "score",
    "member_count", "subscriber_count", "follower_count", "profile_views",
    "points", "karma",
}


def _json_default(obj):
    if isinstance(obj, datetime):
        return obj.isoformat()
    raise TypeError(f"Not JSON serializable: {type(obj)!r}")


def _to_json(val: Any) -> str:
    return json.dumps(val, default=_json_default)


def _coerce_datetimes(obj: Any) -> Any:
    """Recursively convert ISO datetime strings back to datetime objects."""
    if isinstance(obj, dict):
        return {k: _coerce_datetimes(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_coerce_datetimes(v) for v in obj]
    if isinstance(obj, str) and _ISO_DT_RE.match(obj):
        try:
            return datetime.fromisoformat(obj)
        except ValueError:
            return obj
    return obj


def _load_doc(raw_json: str) -> dict:
    return _coerce_datetimes(json.loads(raw_json))


def _get_nested(doc: dict, path: str) -> Any:
    parts = path.split(".")
    cur = doc
    for p in parts:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(p)
    return cur


def _set_nested(doc: dict, path: str, value: Any) -> None:
    parts = path.split(".")
    cur = doc
    for p in parts[:-1]:
        if not isinstance(cur.get(p), dict):
            cur[p] = {}
        cur = cur[p]
    cur[parts[-1]] = value


# ──────────────────────────────────────────────
# MongoDB update operator applicator (Python-side)
# ──────────────────────────────────────────────

def _apply_update(doc: dict, update: dict, filter_dict: Optional[dict] = None) -> dict:
    """Apply MongoDB update operators to a document in-memory."""
    # Deep-copy via JSON round-trip so we never mutate the original
    doc = json.loads(_to_json(doc))
    # Restore datetimes lost in round-trip
    doc = _coerce_datetimes(doc)

    if "$set" in update:
        for path, val in update["$set"].items():
            _set_nested(doc, path, val)

    if "$inc" in update:
        for path, val in update["$inc"].items():
            if "$" in path:
                # Positional array update: e.g. "poll.options.$.votes"
                # Split at ".$." to get array path and field name
                arr_part, _, field = path.partition(".$.")
                arr = _get_nested(doc, arr_part) or []
                if filter_dict:
                    for fk, fv in filter_dict.items():
                        if fk.startswith(arr_part + "."):
                            sub_field = fk[len(arr_part) + 1:]
                            for item in arr:
                                if isinstance(item, dict) and str(item.get(sub_field)) == str(fv):
                                    item[field] = (item.get(field) or 0) + val
                                    break
                            break
                _set_nested(doc, arr_part, arr)
            else:
                current = _get_nested(doc, path) or 0
                _set_nested(doc, path, current + val)

    if "$addToSet" in update:
        for path, val in update["$addToSet"].items():
            arr = list(_get_nested(doc, path) or [])
            if isinstance(val, dict) and "$each" in val:
                for item in val["$each"]:
                    if item not in arr:
                        arr.append(item)
            else:
                if val not in arr:
                    arr.append(val)
            _set_nested(doc, path, arr)

    if "$pull" in update:
        for path, val in update["$pull"].items():
            arr = list(_get_nested(doc, path) or [])
            if isinstance(val, dict):
                if "$in" in val:
                    remove_set = {str(v) for v in val["$in"]}
                    arr = [x for x in arr if str(x) not in remove_set]
                # other dict operators ignored
            else:
                arr = [x for x in arr if x != val]
            _set_nested(doc, path, arr)

    if "$push" in update:
        for path, val in update["$push"].items():
            arr = list(_get_nested(doc, path) or [])
            arr.append(val)
            _set_nested(doc, path, arr)

    # $setOnInsert is handled in update_one's upsert path, not here.
    return doc


def _eq_fields_from_filter(filter_dict: dict) -> dict:
    """The plain equality conditions of a query — the fields MongoDB copies into
    a document it inserts on upsert. Skips logical/operator clauses ($or, $and)
    and operator values ({"$gte": …}, {"$ne": …}, {"$in": […]}) which aren't
    literal values, and _id (Postgres has no such column here)."""
    out: dict = {}
    for k, v in (filter_dict or {}).items():
        if not isinstance(k, str) or k.startswith("$") or k == "_id":
            continue
        if isinstance(v, dict) and any(isinstance(op, str) and op.startswith("$") for op in v):
            continue   # a query operator, not an equality match
        out[k] = v
    return out


def _build_upsert_doc(filter_dict: dict, update: dict) -> dict:
    """The document inserted when an upsert matches no row. MongoDB seeds it from
    the query's equality fields, then applies $setOnInsert and $set. Seeding the
    equality fields is essential: without them a row inserted by e.g.
    update_one({"key": "x"}, {"$set": {"value": v}}, upsert=True) would have no
    `key`, so the matching find_one({"key": "x"}) would never see it again."""
    new_doc: dict = {}
    for path, val in _eq_fields_from_filter(filter_dict or {}).items():
        _set_nested(new_doc, path, val)
    if "$setOnInsert" in update:
        for path, val in update["$setOnInsert"].items():
            _set_nested(new_doc, path, val)
    if "$set" in update:
        for path, val in update["$set"].items():
            _set_nested(new_doc, path, val)
    return new_doc


# ──────────────────────────────────────────────
# Result types
# ──────────────────────────────────────────────

class UpdateResult:
    def __init__(self, matched: int, modified: int, upserted_id=None):
        self.matched_count = matched
        self.modified_count = modified
        self.upserted_id = upserted_id


class DeleteResult:
    def __init__(self, deleted: int):
        self.deleted_count = deleted


# ──────────────────────────────────────────────
# Cursor
# ──────────────────────────────────────────────

class Cursor:
    """Mimics a motor cursor. Call .sort/.limit/.skip then await .to_list(n)."""

    def __init__(self, coll: "Collection", filter_dict: dict, projection=None):
        self._coll = coll
        self._filter = filter_dict
        self._sort_specs: List[Tuple[str, int]] = []
        self._limit_n: Optional[int] = None
        self._skip_n: Optional[int] = None

    def sort(self, *args) -> "Cursor":
        if len(args) == 2 and isinstance(args[0], str):
            self._sort_specs = [(args[0], args[1])]
        elif len(args) == 1 and isinstance(args[0], list):
            self._sort_specs = args[0]
        return self

    def limit(self, n: int) -> "Cursor":
        self._limit_n = n
        return self

    def skip(self, n: int) -> "Cursor":
        self._skip_n = n
        return self

    async def to_list(self, n: Optional[int]) -> List[dict]:
        limit = self._limit_n if self._limit_n is not None else n
        return await self._coll._find_many(
            self._filter, self._sort_specs, limit, self._skip_n
        )


# ──────────────────────────────────────────────
# Collection
# ──────────────────────────────────────────────

class Collection:
    def __init__(self, pool: asyncpg.Pool, name: str):
        self.pool = pool
        self.name = name

    # ── Path helpers ──

    def _is_array_field(self, key: str) -> bool:
        leaf = key.split(".")[-1]
        return leaf in _ARRAY_FIELDS or key in _ARRAY_FIELDS

    def _is_date_field(self, key: str) -> bool:
        leaf = key.split(".")[-1]
        return leaf in _DATE_FIELDS or key in _DATE_FIELDS

    def _is_numeric_field(self, key: str) -> bool:
        leaf = key.split(".")[-1]
        return leaf in _NUMERIC_FIELDS or key in _NUMERIC_FIELDS

    def _sql_text(self, path: str) -> str:
        """Return SQL expression that extracts a text value."""
        parts = path.split(".")
        if len(parts) == 1:
            return f"doc->>'{parts[0]}'"
        r = "doc"
        for i, p in enumerate(parts):
            r += f"->>'{p}'" if i == len(parts) - 1 else f"->'{p}'"
        return r

    def _sql_jsonb(self, path: str) -> str:
        """Return SQL expression that extracts a JSONB value."""
        r = "doc"
        for p in path.split("."):
            r += f"->'{p}'"
        return r

    # ── Filter builder ──

    def _build_condition(self, key: str, value: Any, params: list) -> str:
        if key == "$or":
            parts = [self._build_filter_sql(v, params) for v in value]
            return f"({' OR '.join(parts)})"
        if key == "$and":
            parts = [self._build_filter_sql(v, params) for v in value]
            return f"({' AND '.join(parts)})"
        if key.startswith("$"):
            return "TRUE"

        # Operator dict
        if isinstance(value, dict) and any(k.startswith("$") for k in value):
            conditions: List[str] = []
            for op, op_val in value.items():
                if op == "$options":
                    continue
                if op == "$ne":
                    if op_val is None:
                        conditions.append(f"{self._sql_jsonb(key)} IS NOT NULL")
                    elif self._is_array_field(key):
                        params.append(_to_json([op_val]))
                        conditions.append(
                            f"NOT ({self._sql_jsonb(key)} @> ${len(params)}::jsonb)"
                        )
                    else:
                        params.append(str(op_val))
                        conditions.append(
                            f"({self._sql_text(key)} IS NULL OR {self._sql_text(key)} != ${len(params)})"
                        )
                elif op == "$in":
                    if not op_val:
                        conditions.append("FALSE")
                    else:
                        has_none = any(v is None for v in op_val)
                        non_none = [str(v) for v in op_val if v is not None]
                        parts: List[str] = []
                        if has_none:
                            parts.append(f"{self._sql_text(key)} IS NULL")
                        if non_none:
                            params.append(non_none)
                            parts.append(
                                f"{self._sql_text(key)} = ANY(${len(params)}::text[])"
                            )
                        conditions.append(
                            f"({' OR '.join(parts)})" if parts else "FALSE"
                        )
                elif op == "$all":
                    # Array contains ALL given elements (JSONB containment per item).
                    if not op_val:
                        conditions.append("TRUE")
                    else:
                        for item in op_val:
                            params.append(_to_json([item]))
                            conditions.append(
                                f"{self._sql_jsonb(key)} @> ${len(params)}::jsonb"
                            )
                elif op == "$elemMatch":
                    # Array has an element matching the given equality sub-fields:
                    # field @> [op_val]. (Supports equality sub-conditions, which is
                    # all the callers use, e.g. media: {$elemMatch: {type: "video"}}.)
                    params.append(_to_json([op_val]))
                    conditions.append(
                        f"{self._sql_jsonb(key)} @> ${len(params)}::jsonb"
                    )
                elif op == "$nin":
                    if not op_val:
                        conditions.append("TRUE")
                    else:
                        non_none = [str(v) for v in op_val if v is not None]
                        if non_none:
                            params.append(non_none)
                            conditions.append(
                                f"({self._sql_text(key)} IS NULL OR "
                                f"{self._sql_text(key)} != ALL(${len(params)}::text[]))"
                            )
                elif op in ("$gt", "$gte", "$lt", "$lte"):
                    op_sql = {"$gt": ">", "$gte": ">=", "$lt": "<", "$lte": "<="}[op]
                    if self._is_date_field(key):
                        if isinstance(op_val, datetime):
                            dt = op_val
                        else:
                            dt = datetime.fromisoformat(str(op_val))
                        params.append(dt)
                        conditions.append(
                            f"({self._sql_text(key)})::timestamptz "
                            f"{op_sql} ${len(params)}::timestamptz"
                        )
                    elif isinstance(op_val, (int, float)):
                        params.append(float(op_val))
                        conditions.append(
                            f"({self._sql_text(key)})::float {op_sql} ${len(params)}"
                        )
                    else:
                        params.append(str(op_val))
                        conditions.append(
                            f"{self._sql_text(key)} {op_sql} ${len(params)}"
                        )
                elif op == "$regex":
                    flags = value.get("$options", "")
                    params.append(op_val)
                    op_re = "~*" if "i" in flags else "~"
                    conditions.append(f"{self._sql_text(key)} {op_re} ${len(params)}")
                elif op == "$exists":
                    if op_val:
                        conditions.append(f"{self._sql_jsonb(key)} IS NOT NULL")
                    else:
                        conditions.append(f"{self._sql_jsonb(key)} IS NULL")
            return " AND ".join(conditions) if conditions else "TRUE"

        # Simple equality / array containment
        if value is None:
            # NULL in JSONB: either key missing or explicit null
            return (
                f"({self._sql_jsonb(key)} IS NULL OR "
                f"{self._sql_text(key)} IS NULL)"
            )

        if isinstance(value, bool):
            params.append(str(value).lower())
            return f"{self._sql_text(key)} = ${len(params)}"

        if isinstance(value, list):
            # Exact list or containment check for array fields
            params.append(_to_json(value))
            return f"{self._sql_jsonb(key)} @> ${len(params)}::jsonb"

        if self._is_array_field(key):
            params.append(_to_json([value]))
            return f"{self._sql_jsonb(key)} @> ${len(params)}::jsonb"

        if isinstance(value, datetime):
            params.append(value)
            return (
                f"({self._sql_text(key)})::timestamptz "
                f"= ${len(params)}::timestamptz"
            )

        params.append(str(value))
        return f"{self._sql_text(key)} = ${len(params)}"

    def _build_filter_sql(self, filter_dict: dict, params: list) -> str:
        if not filter_dict:
            return "TRUE"
        conds = [self._build_condition(k, v, params) for k, v in filter_dict.items()]
        return " AND ".join(conds) if conds else "TRUE"

    def _sort_sql(self, specs: List[Tuple[str, int]]) -> str:
        if not specs:
            return ""
        parts = []
        for field, direction in specs:
            dir_sql = "DESC" if direction == -1 else "ASC"
            if self._is_date_field(field):
                parts.append(
                    f"({self._sql_text(field)})::timestamptz {dir_sql} NULLS LAST"
                )
            elif self._is_numeric_field(field):
                # Guard the cast so a stray non-numeric value sorts last rather
                # than erroring the whole query.
                txt = self._sql_text(field)
                parts.append(
                    f"(CASE WHEN {txt} ~ '^-?[0-9]+(\\.[0-9]+)?$' "
                    f"THEN ({txt})::float8 ELSE NULL END) {dir_sql} NULLS LAST"
                )
            else:
                parts.append(f"{self._sql_text(field)} {dir_sql} NULLS LAST")
        return f"ORDER BY {', '.join(parts)}"

    # ── Public API ──

    async def find_one(
        self,
        filter_dict: dict,
        projection=None,
        sort=None,
    ) -> Optional[dict]:
        params: List[Any] = []
        where = self._build_filter_sql(filter_dict or {}, params)
        sort_specs: List[Tuple[str, int]] = sort if isinstance(sort, list) else []
        order = self._sort_sql(sort_specs)
        sql = f"SELECT doc FROM {self.name} WHERE {where} {order} LIMIT 1"
        async with self.pool.acquire() as conn:
            try:
                row = await conn.fetchrow(sql, *params)
            except asyncpg.UndefinedTableError:
                return None  # collection has no rows yet (table not created)
        if row is None:
            return None
        return _load_doc(row["doc"])

    def find(self, filter_dict: dict, projection=None) -> Cursor:
        return Cursor(self, filter_dict or {}, projection)

    async def _find_many(
        self,
        filter_dict: dict,
        sort_specs: List[Tuple[str, int]],
        limit_n: Optional[int],
        skip_n: Optional[int],
    ) -> List[dict]:
        params: List[Any] = []
        where = self._build_filter_sql(filter_dict or {}, params)
        order = self._sort_sql(sort_specs or [])
        limit_clause = f"LIMIT {int(limit_n)}" if limit_n is not None else ""
        skip_clause = f"OFFSET {int(skip_n)}" if skip_n else ""
        sql = (
            f"SELECT doc FROM {self.name} "
            f"WHERE {where} {order} {limit_clause} {skip_clause}"
        )
        async with self.pool.acquire() as conn:
            try:
                rows = await conn.fetch(sql, *params)
            except asyncpg.UndefinedTableError:
                return []  # collection has no rows yet (table not created)
        return [_load_doc(r["doc"]) for r in rows]

    async def _ensure_table(self) -> None:
        """Create this collection's backing table on demand (Mongo-style:
        collections spring into existence on first write)."""
        async with self.pool.acquire() as conn:
            await conn.execute(
                f"CREATE TABLE IF NOT EXISTS {self.name} (doc jsonb NOT NULL)"
            )

    async def insert_one(self, doc: dict) -> None:
        doc_json = _to_json(doc)
        for attempt in (1, 2):
            try:
                async with self.pool.acquire() as conn:
                    await conn.execute(
                        f"INSERT INTO {self.name}(doc) VALUES($1::jsonb)",
                        doc_json,
                    )
                return
            except asyncpg.UndefinedTableError:
                if attempt == 2:
                    raise
                await self._ensure_table()  # first write to a new collection
            except asyncpg.UniqueViolationError as exc:
                raise DuplicateKeyError(str(exc)) from exc

    async def update_one(
        self,
        filter_dict: dict,
        update: dict,
        upsert: bool = False,
    ) -> UpdateResult:
        # Atomic read-modify-write: the matched row is locked with SELECT ... FOR
        # UPDATE for the life of the transaction, so two concurrent callers can't
        # both read the same row, both apply, and both report a match. This is
        # what lets routes use a conditional filter (e.g. {"id": x, "status":
        # "open"}) as a single-winner claim — once the winner commits the new
        # status, the loser's FOR UPDATE re-evaluates the filter and matches no
        # row, returning matched_count=0.
        for attempt in (1, 2, 3):
            try:
                async with self.pool.acquire() as conn:
                    async with conn.transaction():
                        params: List[Any] = []
                        where = self._build_filter_sql(filter_dict or {}, params)
                        locked = await conn.fetchrow(
                            f"SELECT ctid, doc FROM {self.name} WHERE {where} "
                            f"LIMIT 1 FOR UPDATE",
                            *params,
                        )
                        if locked is not None:
                            doc = _load_doc(locked["doc"])
                            updated = _apply_update(doc, update, filter_dict)
                            await conn.execute(
                                f"UPDATE {self.name} SET doc = $1::jsonb "
                                f"WHERE ctid = $2",
                                _to_json(updated), locked["ctid"],
                            )
                            return UpdateResult(1, 1)
                        if not upsert:
                            return UpdateResult(0, 0)
                        # No matching row — insert from the query's equality fields
                        # (MongoDB upsert semantics) plus $setOnInsert + $set.
                        new_doc = _build_upsert_doc(filter_dict or {}, update)
                        await conn.execute(
                            f"INSERT INTO {self.name}(doc) VALUES($1::jsonb)",
                            _to_json(new_doc),
                        )
                        return UpdateResult(0, 0, new_doc.get("id") or True)
            except asyncpg.UndefinedTableError:
                if attempt == 3:
                    raise
                await self._ensure_table()  # first write to a new collection
            except asyncpg.UniqueViolationError as exc:
                # A concurrent insert beat us between the SELECT and the INSERT.
                # Retry: the row now exists, so the locked-update branch claims it
                # (mirroring the old DuplicateKeyError "treat as update" path).
                if attempt == 3:
                    raise DuplicateKeyError(str(exc)) from exc
        return UpdateResult(0, 0)

    async def update_many(
        self,
        filter_dict: dict,
        update: dict,
    ) -> UpdateResult:
        docs = await self._find_many(filter_dict or {}, [], None, None)
        count = 0
        for doc in docs:
            updated = _apply_update(doc, update)
            params: List[Any] = []
            where = self._build_filter_sql(filter_dict, params)
            doc_json = _to_json(updated)
            params.append(doc_json)
            # Use a stable row identifier where available
            if doc.get("id"):
                async with self.pool.acquire() as conn:
                    await conn.execute(
                        f"UPDATE {self.name} SET doc = $1::jsonb "
                        f"WHERE doc->>'id' = $2",
                        doc_json, str(doc["id"]),
                    )
            else:
                sql = (
                    f"UPDATE {self.name} SET doc = ${len(params)}::jsonb "
                    f"WHERE {where}"
                )
                async with self.pool.acquire() as conn:
                    await conn.execute(sql, *params)
            count += 1
        return UpdateResult(count, count)

    async def delete_one(self, filter_dict: dict) -> DeleteResult:
        params: List[Any] = []
        where = self._build_filter_sql(filter_dict or {}, params)
        sql = (
            f"DELETE FROM {self.name} "
            f"WHERE ctid = (SELECT ctid FROM {self.name} WHERE {where} LIMIT 1)"
        )
        async with self.pool.acquire() as conn:
            try:
                result = await conn.execute(sql, *params)
            except asyncpg.UndefinedTableError:
                return DeleteResult(0)
        deleted = int(result.split()[-1])
        return DeleteResult(deleted)

    async def delete_many(self, filter_dict: dict) -> DeleteResult:
        params: List[Any] = []
        where = self._build_filter_sql(filter_dict or {}, params)
        async with self.pool.acquire() as conn:
            try:
                result = await conn.execute(
                    f"DELETE FROM {self.name} WHERE {where}", *params
                )
            except asyncpg.UndefinedTableError:
                return DeleteResult(0)
        deleted = int(result.split()[-1])
        return DeleteResult(deleted)

    async def count_documents(self, filter_dict: dict) -> int:
        params: List[Any] = []
        where = self._build_filter_sql(filter_dict or {}, params)
        async with self.pool.acquire() as conn:
            try:
                row = await conn.fetchrow(
                    f"SELECT COUNT(*) AS n FROM {self.name} WHERE {where}", *params
                )
            except asyncpg.UndefinedTableError:
                return 0
        return row["n"]

    # No-op stubs so any leftover create_index calls don't crash
    async def create_index(self, *args, **kwargs):
        pass


# ──────────────────────────────────────────────
# Database facade  (db.users → Collection)
# ──────────────────────────────────────────────

class Database:
    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool
        self._cols: Dict[str, Collection] = {}

    def __getattr__(self, name: str) -> Collection:
        if name.startswith("_"):
            raise AttributeError(name)
        if name not in self._cols:
            self._cols[name] = Collection(self._pool, name)
        return self._cols[name]


# ──────────────────────────────────────────────
# Pool initialisation
# ──────────────────────────────────────────────

async def init_db(dsn: str) -> Database:
    pool = await asyncpg.create_pool(dsn, min_size=2, max_size=10)
    return Database(pool)
