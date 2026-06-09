"""Voice-note transcription (speech-to-text).

Turns a recorded voice message into text. Two providers are supported and
auto-selected by whichever API key is present — set one in your host's
dashboard and transcription lights up with no code change:

  OPENAI_API_KEY     OpenAI Whisper  (model: OPENAI_STT_MODEL, default whisper-1)
  DEEPGRAM_API_KEY   Deepgram        (model: DEEPGRAM_STT_MODEL, default nova-2)

Best-effort: when no key is configured (or the provider errors) the helper
returns None and the caller surfaces a friendly "transcription unavailable"
message rather than failing the request.

End-to-end encrypted voice notes are opaque to the server, so the client
decrypts the audio and posts the raw bytes to the transcribe endpoint — the
plaintext audio only lives for the duration of that one call and is never
stored.
"""
import base64
import logging
import os
import re
from typing import Optional

import httpx

logger = logging.getLogger("transcribe")

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_STT_MODEL = os.environ.get("OPENAI_STT_MODEL", "whisper-1")
DEEPGRAM_API_KEY = os.environ.get("DEEPGRAM_API_KEY", "")
DEEPGRAM_STT_MODEL = os.environ.get("DEEPGRAM_STT_MODEL", "nova-2")


def transcribe_enabled() -> bool:
    return bool(OPENAI_API_KEY or DEEPGRAM_API_KEY)


def active_provider() -> Optional[str]:
    if OPENAI_API_KEY:
        return "openai"
    if DEEPGRAM_API_KEY:
        return "deepgram"
    return None


def _decode(audio_base64: str) -> tuple[bytes, str, str]:
    """Return (raw_bytes, mime, file_extension) from a possibly data-URI base64
    string. Falls back to m4a, the format expo-av records by default."""
    s = (audio_base64 or "").strip()
    mime = "audio/m4a"
    m = re.match(r"data:([^;]+);base64,", s)
    if m:
        mime = m.group(1)
    s = re.sub(r"^data:[^;]+;base64,", "", s)
    raw = base64.b64decode(s + "=" * (-len(s) % 4))
    ext = {
        "audio/m4a": "m4a", "audio/mp4": "m4a", "audio/x-m4a": "m4a",
        "audio/mpeg": "mp3", "audio/mp3": "mp3",
        "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav",
        "audio/x-wav": "wav", "audio/aac": "aac", "audio/caf": "caf",
    }.get(mime, "m4a")
    return raw, mime, ext


async def _openai(raw: bytes, mime: str, ext: str) -> Optional[str]:
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {OPENAI_API_KEY}"},
                files={"file": (f"voice.{ext}", raw, mime)},
                data={"model": OPENAI_STT_MODEL, "response_format": "json"},
            )
        if resp.status_code != 200:
            logger.warning("Whisper transcribe failed: %s %s", resp.status_code, resp.text[:200])
            return None
        return (resp.json().get("text") or "").strip() or None
    except Exception as e:
        logger.warning("Whisper transcribe error: %s", e)
        return None


async def _deepgram(raw: bytes, mime: str, ext: str) -> Optional[str]:
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                "https://api.deepgram.com/v1/listen",
                headers={"Authorization": f"Token {DEEPGRAM_API_KEY}", "Content-Type": mime},
                params={"model": DEEPGRAM_STT_MODEL, "smart_format": "true", "punctuate": "true"},
                content=raw,
            )
        if resp.status_code != 200:
            logger.warning("Deepgram transcribe failed: %s %s", resp.status_code, resp.text[:200])
            return None
        alts = (((resp.json().get("results") or {}).get("channels") or [{}])[0].get("alternatives") or [{}])
        return (alts[0].get("transcript") or "").strip() or None
    except Exception as e:
        logger.warning("Deepgram transcribe error: %s", e)
        return None


async def transcribe_audio(audio_base64: str) -> Optional[str]:
    """Transcribe a base64 voice note to text, or None if unavailable/failed."""
    prov = active_provider()
    if not prov or not audio_base64:
        return None
    try:
        raw, mime, ext = _decode(audio_base64)
    except Exception:
        return None
    if not raw or len(raw) > 25 * 1024 * 1024:
        return None
    if prov == "openai":
        return await _openai(raw, mime, ext)
    return await _deepgram(raw, mime, ext)
