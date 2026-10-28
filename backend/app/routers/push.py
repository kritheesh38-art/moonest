from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import config
from ..db import get_db
from ..security import current_user
from ..services import push, reminders
from ..utils import parse_date
from .subscriptions import set_skip

router = APIRouter(prefix="/api/push", tags=["push"])


class PushKeys(BaseModel):
    p256dh: str = Field(min_length=20, max_length=200)
    auth: str = Field(min_length=8, max_length=100)


class PushSubIn(BaseModel):
    endpoint: str = Field(pattern=r"^https://", max_length=1000)
    keys: PushKeys
    agent: str = ""


class EndpointIn(BaseModel):
    endpoint: str = Field(max_length=1000)


@router.get("/key")
async def key():
    """The public key browsers subscribe with."""
    return {"enabled": config.PUSH_ENABLED, "public_key": await push.public_key() if config.PUSH_ENABLED else None}


@router.post("/subscribe")
async def subscribe(body: PushSubIn, user: dict = Depends(current_user)):
    await push.subscribe(user["id"], body.model_dump(), body.agent)
    return {"ok": True}


@router.post("/unsubscribe")
async def unsubscribe(body: EndpointIn, user: dict = Depends(current_user)):
    await push.unsubscribe(user["id"], body.endpoint)
    return {"ok": True}


@router.post("/test")
async def test(user: dict = Depends(current_user)):
    """Sends a test alert to this account's devices."""
    sent = await push.send(user["id"], "Notifications are on", "You'll get an alert when your milk is on the way and when it's delivered.")
    return {"sent": sent}


class SkipTokenIn(BaseModel):
    token: str = Field(max_length=4000)


@router.post("/skip")
async def skip_from_reminder(body: SkipTokenIn):
    """The "Skip tomorrow" button on the evening reminder (pressed on the notification, so no sign-in:
    the signed token only skips that customer's deliveries for that day, until the cutoff)."""
    t = reminders.read_skip_token(body.token)
    skipped = 0
    for sub_id in t["subs"]:
        try:
            await set_skip(sub_id, t["uid"], t["day"], True)
            skipped += 1
        except HTTPException as e:
            if e.status_code != 404:  # a cancelled subscription is simply passed over
                raise
    day = parse_date(t["day"]).strftime("%a %d %b")
    return {"ok": True, "skipped": skipped, "message": f"Skipped {day}. No delivery and no charge for that day."}


class PrefsIn(BaseModel):
    skip_reminders: bool


@router.get("/prefs")
async def prefs(user: dict = Depends(current_user)):
    return {"skip_reminders": user.get("skip_reminders", True)}


@router.put("/prefs")
async def set_prefs(body: PrefsIn, user: dict = Depends(current_user)):
    await get_db().users.update_one({"id": user["id"]}, {"$set": {"skip_reminders": body.skip_reminders}})
    return {"skip_reminders": body.skip_reminders}
