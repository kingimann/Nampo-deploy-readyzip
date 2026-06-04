"""Shared pytest config for backend tests.

The mocked-Emergent tests in `test_auth_session_mocked.py` import the
`server` module in-process. Motor's AsyncIOMotorClient binds to the first
event loop it sees, so we force pytest-asyncio to reuse a single
session-scoped loop for all async tests in this dir.
"""
import pytest


def pytest_collection_modifyitems(config, items):
    # Apply session-scoped asyncio loop to every async test in this dir.
    for item in items:
        if item.get_closest_marker("asyncio"):
            item.add_marker(pytest.mark.asyncio(loop_scope="session"))
