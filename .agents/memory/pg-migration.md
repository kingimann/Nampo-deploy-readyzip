---
name: PostgreSQL migration
description: MongoDB Atlas replaced with Replit PostgreSQL (asyncpg) via a JSONB compatibility wrapper
---

## What was done
MongoDB Atlas had TLS incompatibility with OpenSSL 3.6 (Nix Python 3.11). Migrated entirely to Replit's built-in PostgreSQL using asyncpg.

## Architecture
- `backend/db.py` — MongoDB-compatible wrapper: each collection maps to a Postgres table with a single `doc JSONB` column. Exposes `Collection` with `find_one / insert_one / update_one / delete_one / count_documents / find → Cursor`.
- Schema: 26 tables created once via SQL (not on startup). Unique indexes, GIN indexes on JSONB columns, and btree indexes on hot paths.
- `$or`, `$and`, `$in`, `$gte`, `$lte`, `$regex`, `$exists`, `$ne` all handled in `_build_condition`.
- `$set`, `$push`, `$pull`, `$inc`, `$addToSet` handled in `_apply_update`.
- Positional operator `$` in update paths resolved by parsing the filter_dict.
- `_ARRAY_FIELDS` set for `@>` containment vs equality.
- `_DATE_FIELDS` set for `::timestamptz` cast on comparison.
- `_coerce_datetimes` converts ISO strings back to datetime after JSON round-trip.
- `DuplicateKeyError` custom exception wraps `asyncpg.UniqueViolationError`.

## Critical: lazy db proxy pattern
`from core import db` in route files captures the module-level name at import time (before FastAPI startup). If `db` is reassigned on startup (e.g. `db = await init_db()`), route modules still hold the old `None`.

**Fix:** `_DbProxy` class in `core.py` whose `__getattr__` reads from `_real_db` module variable at call time. Route imports get the proxy object; attribute access resolves at runtime after `_real_db` is set.

```python
class _DbProxy:
    def __getattr__(self, name):
        if _real_db is None:
            raise RuntimeError("Database not initialised")
        return getattr(_real_db, name)

db = _DbProxy()

async def init_pool():
    global _real_db
    _real_db = await init_db(dsn)
```

**Why:** Python `from module import name` binds the name's value at import time, not a live reference to the variable.

## Files changed
- `backend/db.py` — new; full wrapper
- `backend/core.py` — removed motor; added _DbProxy + init_pool
- `backend/server.py` — removed startup_indexes; startup calls init_pool
- `backend/requirements.txt` — removed motor/pymongo/dnspython; added asyncpg
- `backend/routes/auth.py`, `posts.py`, `groups.py`, `users.py` — `from pymongo.errors import DuplicateKeyError` → `from db import DuplicateKeyError`
