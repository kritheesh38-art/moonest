"""Shared domain helpers: settings, wallet, COD ledger, subscription calendar."""
import re
from datetime import date, timedelta

from fastapi import HTTPException

from .. import config
from ..db import get_db
from ..utils import clean, new_id, now_iso, parse_date

DEFAULT_SETTINGS = {
    "key": "global",
    "skip_cutoff_hour": 22,  # 10 PM previous night
    "max_pause_days": 30,
    "delivery_fee_paise": 1000,
    "free_delivery_above_paise": 15000,
    "slots": [
        {"code": "morning", "label": "5:30 AM", "time": "05:30"},
        {"code": "evening", "label": "5:00 PM", "time": "17:00"},
    ],
    "city": "Bengaluru",
}

SLOT_LABEL = {"morning": "5:30 AM", "evening": "5:00 PM"}


def display_name(p: dict) -> str:
    """Name on orders, routes and invoices: brand + product (+ packet colour), e.g. "Aavin Nice Toned Milk (Blue packet)"."""
    name = f"{p['brand']} {p['name']}" if p.get("brand") and p["brand"] != "MooNest Farms" else p["name"]
    return name + (f" ({p['pack_label']} packet)" if p.get("pack_label") else "")


async def get_settings() -> dict:
    s = clean(await get_db().settings.find_one({"key": "global"}))
    merged = dict(DEFAULT_SETTINGS)
    merged.update(s or {})
    return merged


# ---------------- wallet ----------------
async def wallet_balance(user_id: str) -> int:
    u = await get_db().users.find_one({"id": user_id}, {"wallet_paise": 1})
    return int((u or {}).get("wallet_paise", 0))


async def wallet_credit(user_id: str, amount: int, reason: str, ref: str = "", note: str = "") -> dict:
    d = get_db()
    u = await d.users.find_one_and_update(
        {"id": user_id}, {"$inc": {"wallet_paise": amount}}, return_document=True
    )
    entry = {
        "id": new_id(), "user_id": user_id, "type": "credit", "amount_paise": amount,
        "reason": reason, "ref": ref, "note": note,
        "balance_after_paise": int(u.get("wallet_paise", 0)), "created_at": now_iso(),
    }
    await d.wallet_ledger.insert_one(entry)
    return clean(entry)


async def wallet_debit(user_id: str, amount: int, reason: str, ref: str = "", note: str = "") -> dict | None:
    """Debit if the balance covers it. Returns the ledger entry or None if insufficient."""
    d = get_db()
    u = await d.users.find_one_and_update(
        {"id": user_id, "wallet_paise": {"$gte": amount}},
        {"$inc": {"wallet_paise": -amount}},
        return_document=True,
    )
    if not u:
        return None
    entry = {
        "id": new_id(), "user_id": user_id, "type": "debit", "amount_paise": amount,
        "reason": reason, "ref": ref, "note": note,
        "balance_after_paise": int(u.get("wallet_paise", 0)), "created_at": now_iso(),
    }
    await d.wallet_ledger.insert_one(entry)
    return clean(entry)


# ---------------- COD ----------------
async def cod_add_due(user_id: str, amount: int, ref: str, note: str = ""):
    await get_db().cod_ledger.insert_one({
        "id": new_id(), "user_id": user_id, "type": "due", "amount_paise": amount,
        "ref": ref, "note": note, "created_at": now_iso(),
    })


async def cod_collect(user_id: str, agent_id: str, amount: int, ref: str = "", trip_id: str = "",
                      date: str = ""):
    entry = {
        "id": new_id(), "user_id": user_id, "agent_id": agent_id, "type": "collected",
        "amount_paise": amount, "ref": ref, "trip_id": trip_id, "date": date or now_iso()[:10],
        "reconciled": False, "created_at": now_iso(),
    }
    await get_db().cod_ledger.insert_one(entry)
    return clean(entry)


async def cod_balance(user_id: str) -> int:
    """Cash the customer still owes (dues minus collections)."""
    total = 0
    async for e in get_db().cod_ledger.find({"user_id": user_id}):
        if e["type"] == "due":
            total += e["amount_paise"]
        elif e["type"] in ("collected", "waived"):
            total -= e["amount_paise"]
    return total


# ---------------- subscription calendar ----------------
def plan_matches(sub: dict, d: date) -> bool:
    start = parse_date(sub["start_date"])
    if d < start:
        return False
    code = sub["plan_code"]
    if code == "daily":
        return True
    if code == "alternate":
        return (d - start).days % 2 == 0
    if code == "custom":
        return d.weekday() in sub.get("custom_days", [])
    return False


def paused_on(sub: dict, d: date) -> dict | None:
    for p in sub.get("pauses", []):
        if parse_date(p["start_date"]) <= d <= parse_date(p["end_date"]):
            return p
    return None


def delivers_on(sub: dict, d: date) -> bool:
    return (
        sub.get("status") == "active"
        and plan_matches(sub, d)
        and d.isoformat() not in sub.get("skips", [])
        and not paused_on(sub, d)
    )


def upcoming_dates(sub: dict, start: date, days: int = 14) -> list[dict]:
    out = []
    for i in range(days):
        d = start + timedelta(days=i)
        if not plan_matches(sub, d) or sub.get("status") != "active":
            continue
        state = "scheduled"
        if d.isoformat() in sub.get("skips", []):
            state = "skipped"
        elif paused_on(sub, d):
            state = "paused"
        out.append({"date": d.isoformat(), "state": state})
    return out


async def plan_by_code(code: str) -> dict:
    p = clean(await get_db().plans.find_one({"code": code}))
    if not p or not p.get("active", True):
        raise HTTPException(400, "This plan is not available")
    return p


def unit_price(product: dict, plan: dict) -> int:
    disc = float(plan.get("discount_pct", 0) or 0)
    return int(round(product["price_paise"] * (100 - disc) / 100))


async def serviceable(pincode: str) -> dict | None:
    """The delivery area for a pincode. Areas are managed in Admin; one switched off is never served.

    In demo mode any other valid Indian pincode is accepted as a test area (placed at the depot and
    routed to the demo agent), so testers anywhere can complete the whole flow.
    """
    area = clean(await get_db().areas.find_one({"pincode": pincode}))
    if area:
        return area if area.get("active", True) else None
    if config.DEMO_MODE and re.fullmatch(r"[1-9]\d{5}", pincode or ""):
        return {"pincode": pincode, "name": f"Pincode {pincode} (test mode)", "lat": config.DEPOT_LAT,
                "lng": config.DEPOT_LNG, "active": True, "test_area": True}
    return None
