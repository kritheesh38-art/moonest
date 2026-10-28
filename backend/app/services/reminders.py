"""Evening "skip tomorrow?" reminder: an hour before the nightly cutoff, customers with a delivery
tomorrow get a push with a one-tap "Skip tomorrow" button (fewer wasted deliveries).

The button works without opening the app: the push carries a signed link that can only skip that
customer's deliveries for that one day, and only until the cutoff.
"""
import logging
from datetime import date, datetime, time, timedelta

import jwt
from fastapi import HTTPException
from pymongo.errors import DuplicateKeyError

from .. import config
from ..db import get_db
from ..utils import IST, clean, now_iso
from . import push
from .core import SLOT_LABEL, delivers_on, display_name

log = logging.getLogger("moonest.reminders")
AUDIENCE = "skip-tomorrow"


def cutoff_at(d: date, cutoff_hour: int) -> datetime:
    """Changes for day `d` close at `cutoff_hour` the night before."""
    return datetime.combine(d - timedelta(days=1), time(cutoff_hour), tzinfo=IST)


def skip_token(user_id: str, sub_ids: list[str], d: date, cutoff_hour: int) -> str:
    return jwt.encode({"aud": AUDIENCE, "uid": user_id, "subs": sub_ids, "day": d.isoformat(),
                       "exp": int(cutoff_at(d, cutoff_hour).timestamp())}, config.JWT_SECRET, algorithm="HS256")


def read_skip_token(token: str) -> dict:
    try:
        return jwt.decode(token, config.JWT_SECRET, algorithms=["HS256"], audience=AUDIENCE)
    except jwt.ExpiredSignatureError:
        raise HTTPException(400, "Too late: changes for tomorrow are closed")
    except jwt.PyJWTError:
        raise HTTPException(400, "This skip link isn't valid. Open the app to skip.")


async def send_skip_reminders(d: date, cutoff_hour: int) -> dict:
    """Push tomorrow's reminder to every customer with a delivery on `d` who has notifications on."""
    db = get_db()
    by_user: dict[str, list[dict]] = {}
    async for sub in db.subscriptions.find({"status": "active"}):
        sub = clean(sub)
        if delivers_on(sub, d):
            by_user.setdefault(sub["user_id"], []).append(sub)
    sent = users = 0
    names = {p["id"]: display_name(clean(p)) async for p in db.products.find({})}
    for user_id, subs in by_user.items():
        user = await db.users.find_one({"id": user_id}, {"skip_reminders": 1})
        if not user or user.get("skip_reminders") is False:
            continue
        if not await db.push_subs.count_documents({"user_id": user_id}):
            continue
        what = ", ".join(f"{names.get(s['product_id'], 'Milk')} × {s['quantity']} at {SLOT_LABEL[s['slot']]}" for s in subs)
        cutoff_label = time(cutoff_hour).strftime("%I %p").lstrip("0")
        token = skip_token(user_id, [s["id"] for s in subs], d, cutoff_hour)
        n = await push.send(user_id, f"Milk tomorrow, {d.strftime('%a %d %b')}",
                            f"{what}. Not needed? Skip before {cutoff_label}.", "skip_reminder", d.isoformat(),
                            extra={"actions": [{"action": "skip", "title": "Skip tomorrow"}], "skip_token": token})
        users += 1
        sent += n
    return {"date": d.isoformat(), "customers": users, "pushes": sent}


async def send_once(d: date, cutoff_hour: int) -> dict | None:
    """Send the evening reminders for `d` once, even with several servers or restarts."""
    try:
        await get_db().reminder_runs.insert_one({"date": d.isoformat(), "at": now_iso()})
    except DuplicateKeyError:
        return None
    return await send_skip_reminders(d, cutoff_hour)
