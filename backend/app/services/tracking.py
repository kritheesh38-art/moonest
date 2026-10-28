"""In-process pub/sub for live agent locations (one channel per agent + a fleet channel).

For multiple backend instances, replace with Redis pub/sub; the interface stays the same.
"""
from collections import defaultdict
from datetime import datetime

from fastapi import WebSocket

from .. import config
from ..utils import haversine_km, now_ist

AVG_SPEED_KMPH = 18
ROAD_FACTOR = 1.3
MINUTES_PER_STOP = 2


class Hub:
    def __init__(self):
        self.channels: dict[str, set[WebSocket]] = defaultdict(set)

    def subscribe(self, channel: str, ws: WebSocket):
        self.channels[channel].add(ws)

    def unsubscribe(self, channel: str, ws: WebSocket):
        self.channels[channel].discard(ws)

    async def publish(self, channel: str, message: dict):
        dead = []
        for ws in list(self.channels.get(channel, ())):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.unsubscribe(channel, ws)


hub = Hub()
customer_watchers: dict[str, set[tuple[WebSocket, str]]] = defaultdict(set)  # agent_id -> (ws, delivery_id)


def eta_minutes(loc: dict | None, stops_ahead: list[dict], target: dict) -> int | None:
    """Rough ETA: distance via remaining stops at city speed, plus time per stop."""
    if not loc:
        return None
    points = [(s["address"].get("lat"), s["address"].get("lng")) for s in stops_ahead]
    points.append((target["address"].get("lat"), target["address"].get("lng")))
    km, (plat, plng) = 0.0, (loc["lat"], loc["lng"])
    for lat, lng in points:
        if lat is None or lng is None:
            continue
        km += haversine_km(plat, plng, lat, lng)
        plat, plng = lat, lng
    minutes = km * ROAD_FACTOR / AVG_SPEED_KMPH * 60 + MINUTES_PER_STOP * len(stops_ahead)
    return max(1, round(minutes))


def signal_state(loc: dict | None) -> dict:
    if not loc:
        return {"signal": "none", "age_seconds": None}
    age = (now_ist() - datetime.fromisoformat(loc["ts"])).total_seconds()
    return {"signal": "live" if age <= config.SIGNAL_LOST_AFTER_SECONDS else "lost", "age_seconds": int(age)}
