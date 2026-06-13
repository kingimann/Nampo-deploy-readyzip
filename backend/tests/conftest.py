"""Shared pytest config for backend tests.

These tests import the `server` module and exercise it in-process. We force
pytest-asyncio to reuse a single session-scoped event loop for every async
test in this dir so loop-bound resources (DB pool, etc.) stay consistent
across tests.
"""
import pytest


def pytest_collection_modifyitems(config, items):
    # Apply session-scoped asyncio loop to every async test in this dir.
    for item in items:
        if item.get_closest_marker("asyncio"):
            item.add_marker(pytest.mark.asyncio(loop_scope="session"))
