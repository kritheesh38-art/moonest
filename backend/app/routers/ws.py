import asyncio
import json

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from ..db import get_db
from ..security import user_from_token
from ..services.routing import tracking_payload
from ..services.tracking import customer_watchers, hub
from ..utils import clean, today_ist

router = APIRouter()


async def _auth(ws: WebSocket, role: str) -> dict | None:
    """The app sends its session token as the first message (kept out of URLs, so it never lands in
    access logs); `?token=` still works for older clients."""
    token = ws.query_params.get("token", "")
    if not token:
        try:
            first = await asyncio.wait_for(ws.receive_text(), timeout=10)
            token = json.loads(first).get("token", "") if first.startswith("{") else ""
        except (asyncio.TimeoutError, WebSocketDisconnect, ValueError):
            token = ""
    try:
        user = await user_from_token(token)
    except HTTPException:
        user = None
    if not user or user["role"] != role:
        await ws.close(code=4401)
        return None
    return user


@router.websocket("/api/ws/track/{delivery_id}")
async def track(ws: WebSocket, delivery_id: str):
    """Customer subscribes to the agent assigned to one of their deliveries today."""
    await ws.accept()
    user = await _auth(ws, "customer")
    if not user:
        return
    d = clean(await get_db().deliveries.find_one({"id": delivery_id, "user_id": user["id"],
                                                  "date": today_ist().isoformat()}))
    if not d or not d.get("agent_id"):
        await ws.send_json({"type": "error", "message": "No live delivery to track"})
        await ws.close()
        return
    key = (ws, delivery_id)
    customer_watchers[d["agent_id"]].add(key)
    try:
        await ws.send_json({"type": "tracking", **(await tracking_payload(d))})
        while True:
            await ws.receive_text()  # keep-alive pings from the client
            fresh = clean(await get_db().deliveries.find_one({"id": delivery_id}))
            await ws.send_json({"type": "tracking", **(await tracking_payload(fresh))})
    except WebSocketDisconnect:
        pass
    finally:
        customer_watchers[d["agent_id"]].discard(key)


@router.websocket("/api/ws/fleet")
async def fleet(ws: WebSocket):
    await ws.accept()
    if not await _auth(ws, "admin"):
        return
    hub.subscribe("fleet", ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.unsubscribe("fleet", ws)
