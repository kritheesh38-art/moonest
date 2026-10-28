import logging

import httpx

from .. import config
from ..db import get_db
from ..utils import e164, new_id, now_iso
from . import push

log = logging.getLogger("moonest.notify")


async def send_sms(phone10: str, body: str) -> bool:
    if not config.twilio_enabled():
        log.info("[sms:disabled] to=%s body=%s", phone10, body)
        return False
    url = f"https://api.twilio.com/2010-04-01/Accounts/{config.TWILIO_ACCOUNT_SID}/Messages.json"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(
                url,
                data={"To": e164(phone10), "From": config.TWILIO_FROM_NUMBER, "Body": body},
                auth=(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN),
            )
        if r.status_code >= 300:
            log.warning("Twilio error %s: %s", r.status_code, r.text[:300])
            return False
        return True
    except httpx.HTTPError as e:
        log.warning("Twilio request failed: %s", e)
        return False


async def notify(user_id: str, title: str, body: str, kind: str = "info", ref: str = "",
                 image_url: str = "", sms: bool = False) -> dict:
    """Store an in-app notification (picked up by the browser for push) and optionally SMS."""
    d = get_db()
    n = {
        "id": new_id(), "user_id": user_id, "title": title, "body": body, "kind": kind,
        "ref": ref, "image_url": image_url, "read": False, "sms_sent": False, "created_at": now_iso(),
    }
    if sms:
        u = await d.users.find_one({"id": user_id}, {"phone": 1})
        if u and u.get("phone"):
            n["sms_sent"] = await send_sms(u["phone"], f"MooNest: {body}")
    await d.notifications.insert_one(n)
    n.pop("_id", None)
    push.send_later(user_id, title, body, kind, ref, image_url)  # phone alert, even with the app closed
    return n
