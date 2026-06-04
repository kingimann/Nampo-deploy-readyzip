"""Symmetric encryption for messages at rest (Fernet / AES-128-CBC + HMAC).

Key is loaded from MESSAGE_ENC_KEY env var. If absent or invalid, the
helpers transparently fall through (return text as-is) so the app keeps
working — but a warning is logged.
"""
from __future__ import annotations

import logging
import os
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

logger = logging.getLogger("encryption")

_PREFIX = "enc::"  # marker so we know which strings were ever encrypted
_KEY = os.environ.get("MESSAGE_ENC_KEY")
_F: Optional[Fernet]
try:
    _F = Fernet(_KEY) if _KEY else None
except Exception:
    _F = None
    logger.warning("MESSAGE_ENC_KEY is invalid; messages will NOT be encrypted at rest")


def encrypt_text(plain: Optional[str]) -> Optional[str]:
    if plain is None or plain == "":
        return plain
    if _F is None:
        return plain
    token = _F.encrypt(plain.encode("utf-8")).decode("utf-8")
    return f"{_PREFIX}{token}"


def decrypt_text(value: Optional[str]) -> Optional[str]:
    if value is None or value == "":
        return value
    if not isinstance(value, str):
        return value
    if not value.startswith(_PREFIX):
        return value  # legacy plaintext (pre-encryption)
    if _F is None:
        return value  # can't decrypt — surface raw so dev sees the problem
    try:
        return _F.decrypt(value[len(_PREFIX):].encode("utf-8")).decode("utf-8")
    except InvalidToken:
        logger.warning("Could not decrypt a message (wrong key or tampered)")
        return ""
