"""Phone / browser push notifications (Web Push), free: no SMS or app store needed.

The server's VAPID key pair comes from VAPID_PRIVATE_KEY, or is made once and kept in the real
database, so it survives restarts and needs no setup. Customers' browsers subscribe with the public
key; every in-app notification is then also pushed to their subscribed devices. Works on Android
(Chrome, Samsung Internet, Firefox), desktop browsers, and iPhone (iOS 16.4+) once the app is added
to the home screen.
"""
import asyncio
import base64
import json
import logging

from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid02
from pywebpush import WebPushException, webpush

from .. import config
from ..db import get_db, real_db
from ..utils import now_iso

log = logging.getLogger("moonest.push")
_vapid: Vapid02 | None = None
_lock = asyncio.Lock()
_tasks: set[asyncio.Task] = set()  # keeps background sends alive until done

# Where tapping a notification takes the customer
OPEN_URL = {"tracking": "/#/track", "delivered": "/#/track", "skip_reminder": "/#/subscriptions"}


async def vapid() -> Vapid02:
    global _vapid
    if _vapid:
        return _vapid
    async with _lock:
        if _vapid:
            return _vapid
        pem = config.VAPID_PRIVATE_KEY.replace("\\n", "\n").strip()
        if not pem:
            saved = await real_db().settings.find_one({"key": "vapid"})
            if not saved:
                v = Vapid02()
                v.generate_keys()
                fresh = v.private_pem().decode()
                await real_db().settings.update_one({"key": "vapid"}, {"$setOnInsert": {"private_pem": fresh}}, upsert=True)
                saved = await real_db().settings.find_one({"key": "vapid"})  # another instance may have won
            pem = saved["private_pem"]
        _vapid = Vapid02.from_pem(pem.encode())
        return _vapid


async def public_key() -> str:
    raw = (await vapid()).public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


async def subscribe(user_id: str, sub: dict, agent: str = "") -> None:
    await get_db().push_subs.update_one(
        {"endpoint": sub["endpoint"]},
        {"$set": {"user_id": user_id, "keys": sub["keys"], "agent": agent[:200], "updated_at": now_iso()},
         "$setOnInsert": {"created_at": now_iso()}}, upsert=True)


async def unsubscribe(user_id: str, endpoint: str) -> None:
    await get_db().push_subs.delete_one({"endpoint": endpoint, "user_id": user_id})


def _send_one(sub: dict, payload: str, key: Vapid02) -> int:
    """Returns the push service's status (201 = sent; 404/410 = the device unsubscribed)."""
    try:
        r = webpush({"endpoint": sub["endpoint"], "keys": sub["keys"]}, payload, vapid_private_key=key,
                    vapid_claims={"sub": config.VAPID_CONTACT}, ttl=6 * 3600, timeout=10,
                    headers={"Urgency": "high"})
        return getattr(r, "status_code", 201)
    except WebPushException as e:
        return e.response.status_code if e.response is not None else 0
    except Exception as e:  # noqa: BLE001 - a bad device must never break the request that notified
        log.warning("Push failed: %s", e)
        return 0


async def send(user_id: str, title: str, body: str, kind: str = "", ref: str = "", image_url: str = "",
               extra: dict | None = None) -> int:
    """Push to every device the user turned notifications on for. Returns how many got it."""
    if not config.PUSH_ENABLED:
        return 0
    db = get_db()
    subs = [s async for s in db.push_subs.find({"user_id": user_id})]
    if not subs:
        return 0
    key = await vapid()
    payload = json.dumps({"title": title, "body": body, "tag": f"{kind}:{ref}" if ref else kind or "moonest",
                          "url": OPEN_URL.get(kind, "/#/notifications"), "image": image_url or None, **(extra or {})})
    sent = 0
    for s in subs:
        status = await asyncio.to_thread(_send_one, s, payload, key)
        if status in (404, 410):  # gone: the customer turned it off or cleared the browser
            await db.push_subs.delete_one({"endpoint": s["endpoint"]})
        elif 200 <= status < 300:
            sent += 1
        else:
            log.warning("Push to %s… returned %s", s["endpoint"][:40], status)
    return sent


def send_later(*args, **kw) -> None:
    """Push in the background so the request that caused it isn't slowed down."""
    try:
        t = asyncio.get_running_loop().create_task(send(*args, **kw))
    except RuntimeError:
        return
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)
