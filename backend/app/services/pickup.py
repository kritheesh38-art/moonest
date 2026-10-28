"""Packet pickup list: how many packets of each product an agent collects from the dairy for a day.

Once the day's routes are built (after the nightly cutoff, or when the first agent opens the app),
the list is exact. Before that it is an estimate from the active subscriptions and confirmed orders.
"""
import re
from datetime import date

from ..db import get_db
from ..utils import clean, parse_date
from .core import delivers_on
from .routing import _address, _agent_for_pincode

COUNTED = ("pending", "delivered")  # skipped / failed stops need no packet


def _litres(unit: str, qty: int, category: str = "milk") -> float:
    """Milk volume for "500 ml", "1 L" and the like; 0 for other products (ghee jars, curd, paneer)."""
    if category != "milk":
        return 0.0
    m = re.match(r"\s*(\d+(?:\.\d+)?)\s*(ml|l)\b", unit or "", re.I)
    if not m:
        return 0.0
    return float(m[1]) * (0.001 if m[2].lower() == "ml" else 1.0) * qty


async def _products() -> dict[str, dict]:
    return {p["id"]: clean(p) async for p in get_db().products.find({})}


def _add(groups: dict, agent_id: str | None, item: dict, slot: str, products: dict):
    p = products.get(item.get("product_id"), {})
    g = groups.setdefault(agent_id, {})
    row = g.setdefault(item.get("product_id") or item.get("name"), {
        "product_id": item.get("product_id"), "brand": p.get("brand", ""), "name": p.get("name") or item.get("name", ""),
        "unit": p.get("unit") or item.get("unit", ""), "pack_label": p.get("pack_label"), "pack_color": p.get("pack_color"),
        "category": p.get("category", ""), "morning": 0, "evening": 0, "qty": 0, "litres": 0.0})
    row[slot] = row.get(slot, 0) + item["qty"]
    row["qty"] += item["qty"]
    row["litres"] = round(row["litres"] + _litres(row["unit"], item["qty"], row["category"]), 2)


async def _estimate(d: date, products: dict) -> dict:
    """What the routes will hold for `d`, before they're built (no charging, nothing saved)."""
    db = get_db()
    groups: dict = {}
    agent_of: dict[str, str | None] = {}

    async def agent(pincode: str):
        if pincode not in agent_of:
            agent_of[pincode] = await _agent_for_pincode(pincode)
        return agent_of[pincode]
    async for sub in db.subscriptions.find({"status": "active"}):
        sub = clean(sub)
        if not delivers_on(sub, d):
            continue
        addr_id = sub.get("pending_address_id") if sub.get("pending_address_id") and \
            d >= parse_date(sub["pending_effective_date"]) else sub["address_id"]
        addr = await _address(addr_id)
        if addr:
            _add(groups, await agent(addr["pincode"]), {"product_id": sub["product_id"], "qty": sub["quantity"]},
                 sub["slot"], products)
    async for o in db.orders.find({"delivery_date": d.isoformat(), "status": "confirmed"}):
        a = await agent(o["address"]["pincode"])
        for it in o["items"]:
            _add(groups, a, it, o["slot"], products)
    return groups


async def pickup_list(d: date, agent_id: str | None = None) -> dict:
    """{date, estimate, agents: [{agent_id, items: [...], total_packets, total_litres}], total: [...]}"""
    db = get_db()
    products = await _products()
    q = {"date": d.isoformat(), "status": {"$in": list(COUNTED)}}
    built = await db.deliveries.count_documents({"date": d.isoformat()}) > 0
    groups: dict = {}
    if built:
        async for s in db.deliveries.find(q):
            for it in s["items"]:
                _add(groups, s.get("agent_id"), it, s["slot"], products)
    else:
        groups = await _estimate(d, products)
    if agent_id is not None:
        groups = {agent_id: groups.get(agent_id, {})}

    def finish(rows: dict) -> dict:
        items = sorted(rows.values(), key=lambda r: (r["category"] != "milk", r["brand"], r["name"], r["unit"]))
        return {"items": items, "total_packets": sum(r["qty"] for r in items),
                "total_litres": round(sum(r["litres"] for r in items), 2)}
    names = {u["id"]: u.get("name", "") async for u in db.users.find({"roles": "agent"}, {"id": 1, "name": 1})}
    agents = [{"agent_id": a, "name": names.get(a, "") if a else "No agent yet", **finish(rows)}
              for a, rows in groups.items()]
    agents.sort(key=lambda g: (g["agent_id"] is None, g["name"]))
    total: dict = {}
    for rows in groups.values():
        for key, r in rows.items():
            t = total.setdefault(key, {**r, "morning": 0, "evening": 0, "qty": 0, "litres": 0.0})
            for f in ("morning", "evening", "qty"):
                t[f] += r[f]
            t["litres"] = round(t["litres"] + r["litres"], 2)
    return {"date": d.isoformat(), "estimate": not built, "agents": agents, **{"total": finish(total)}}
