"""Regression tests for the DB wrapper's upsert insert-document construction.

The registration-mode bug: update_one({"key": "registration_mode"},
{"$set": {"value": v}}, upsert=True) inserted a row WITHOUT `key`, so the
matching find_one({"key": "registration_mode"}) never saw it and the public
config kept reporting the default. MongoDB seeds an upsert insert from the
query's equality fields; these pin that behaviour.
"""
from db import _eq_fields_from_filter, _build_upsert_doc


# ── _eq_fields_from_filter: keep equality, drop operators ───────────────────
def test_keeps_plain_equality():
    assert _eq_fields_from_filter({"key": "registration_mode"}) == {"key": "registration_mode"}
    assert _eq_fields_from_filter({"code": "ABC", "used": False}) == {"code": "ABC", "used": False}


def test_drops_operator_values_and_logical_clauses():
    f = {"code": "ABC", "used": {"$ne": True}, "$or": [{"a": 1}], "_id": 0,
         "created_at": {"$gte": "2026-01-01"}}
    assert _eq_fields_from_filter(f) == {"code": "ABC"}


def test_empty_filter():
    assert _eq_fields_from_filter({}) == {}
    assert _eq_fields_from_filter(None) == {}


# ── _build_upsert_doc: the actual fix ───────────────────────────────────────
def test_registration_mode_upsert_includes_key():
    doc = _build_upsert_doc({"key": "registration_mode"}, {"$set": {"value": "closed"}})
    assert doc == {"key": "registration_mode", "value": "closed"}
    # The row is now findable by the same query the readers use.
    assert doc.get("key") == "registration_mode"


def test_set_on_insert_then_set_applied():
    doc = _build_upsert_doc(
        {"key": "k"},
        {"$setOnInsert": {"created": 1}, "$set": {"value": 2}},
    )
    assert doc == {"key": "k", "created": 1, "value": 2}


def test_operator_filter_not_copied_into_insert():
    # A conditional claim filter must not leak its operator field into the doc.
    doc = _build_upsert_doc({"code": "X", "used": {"$ne": True}}, {"$set": {"used": True}})
    assert doc == {"code": "X", "used": True}
