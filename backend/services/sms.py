"""Outbound SMS via Twilio (optional). When Twilio isn't configured, sending is
a no-op and callers fall back to a dev flow (the code is returned to the client
so phone verification can still be tested)."""
import os

import httpx

TWILIO_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM = os.environ.get("TWILIO_FROM_NUMBER", "")


def sms_enabled() -> bool:
    return bool(TWILIO_SID and TWILIO_TOKEN and TWILIO_FROM)


async def send_sms(to: str, body: str) -> bool:
    """Send an SMS. Returns True if Twilio accepted it, False otherwise."""
    if not sms_enabled():
        return False
    url = f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_SID}/Messages.json"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                url,
                auth=(TWILIO_SID, TWILIO_TOKEN),
                data={"To": to, "From": TWILIO_FROM, "Body": body},
            )
            return r.status_code in (200, 201)
    except Exception:
        return False
