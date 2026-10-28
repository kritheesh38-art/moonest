from fastapi import APIRouter, Depends, Form, HTTPException

from ..db import get_db
from ..schemas import CashIn, EndTripIn, FailIn, LocationIn, Slot, TripStart
from ..security import agent_only
from ..services.core import SLOT_LABEL, cod_add_due, cod_balance, cod_collect, wallet_credit
from ..services.notify import notify
from ..services.pickup import pickup_list
from ..services.routing import broadcast_agent, generate_once, handle_missed
from ..utils import clean, new_id, now_iso, parse_date, rupees, today_ist

router = APIRouter(prefix="/api/agent", tags=["agent"])

FAIL_TEXT = {
    "customer_unavailable": "customer unavailable", "address_not_found": "address not found",
    "gate_locked": "gate locked", "refused": "delivery refused", "out_of_stock": "item out of stock",
    "other": "other reason",
}


async def ensure_today_routes():
    db = get_db()
    today = today_ist().isoformat()
    if not await db.route_runs.find_one({"date": today}):
        await generate_once(today_ist(), "on_demand")


async def _active_trip(agent_id: str) -> dict | None:
    """Today's running trip. One left open on an earlier day is closed automatically."""
    db = get_db()
    today = today_ist().isoformat()
    await db.trips.update_many({"agent_id": agent_id, "status": "active", "date": {"$lt": today}},
                               {"$set": {"status": "ended", "ended_at": now_iso(), "auto_ended": True}})
    return clean(await db.trips.find_one({"agent_id": agent_id, "status": "active", "date": today}))


async def _stop(delivery_id: str, agent: dict) -> dict:
    d = clean(await get_db().deliveries.find_one({"id": delivery_id, "agent_id": agent["id"]}))
    if not d:
        raise HTTPException(404, "Stop not found on your route")
    return d


async def _tally(agent_id: str, date: str) -> dict:
    db = get_db()
    cash = 0
    async for e in db.cod_ledger.find({"agent_id": agent_id, "type": "collected", "date": date}):
        cash += e["amount_paise"]
    counts = {"pending": 0, "delivered": 0, "skipped": 0, "failed": 0}
    async for d in db.deliveries.find({"agent_id": agent_id, "date": date}):
        counts[d["status"]] = counts.get(d["status"], 0) + 1
    return {"cash_collected_paise": cash, **counts, "total": sum(counts.values())}


@router.get("/today")
async def today(slot: Slot | None = None, agent: dict = Depends(agent_only)):
    await ensure_today_routes()
    db = get_db()
    date = today_ist().isoformat()
    q = {"agent_id": agent["id"], "date": date}
    if slot:
        q["slot"] = slot
    stops = []
    async for d in db.deliveries.find(q).sort([("slot", 1), ("sequence", 1)]):
        d = clean(d)
        d["cod_due_paise"] = await cod_balance(d["user_id"]) if d["payment_method"] == "cod" else 0
        stops.append(d)
    return {"date": date, "agent": {"id": agent["id"], "name": agent.get("name", "")},
            "trip": await _active_trip(agent["id"]), "stops": stops, "tally": await _tally(agent["id"], date)}


@router.get("/pickup")
async def pickup(date: str | None = None, agent: dict = Depends(agent_only)):
    """Packets to collect from the dairy for a day (today by default; tomorrow's is exact after the cutoff)."""
    d = parse_date(date) if date else today_ist()
    if not 0 <= (d - today_ist()).days <= 2:
        raise HTTPException(400, "Pick today or the next two days")
    if d == today_ist():
        await ensure_today_routes()
    res = await pickup_list(d, agent["id"])
    return {"date": res["date"], "estimate": res["estimate"], **res["agents"][0]}


@router.post("/trips/start")
async def start_trip(body: TripStart, agent: dict = Depends(agent_only)):
    db = get_db()
    if await _active_trip(agent["id"]):
        raise HTTPException(400, "A trip is already in progress")
    date = today_ist().isoformat()
    trip = {"id": new_id(), "agent_id": agent["id"], "date": date, "slot": body.slot, "status": "active",
            "started_at": now_iso(), "last_location": None}
    await db.trips.insert_one(dict(trip))
    notified = set()
    async for d in db.deliveries.find({"agent_id": agent["id"], "date": date, "slot": body.slot, "status": "pending"}):
        if d["user_id"] not in notified:
            notified.add(d["user_id"])
            await notify(d["user_id"], "Your milk is on the way",
                         f"{agent.get('name') or 'Your milk agent'} has started the {SLOT_LABEL[body.slot]} route. "
                         "Track live in the app.", "tracking", d["id"])
    await broadcast_agent(agent["id"])
    return trip


@router.post("/location")
async def post_location(body: LocationIn, agent: dict = Depends(agent_only)):
    db = get_db()
    trip = await _active_trip(agent["id"])
    if not trip:
        raise HTTPException(409, "Start a trip to share location")
    loc = {**body.model_dump(), "ts": now_iso()}
    await db.trips.update_one({"id": trip["id"]}, {"$set": {"last_location": loc}})
    await db.locations.insert_one({"trip_id": trip["id"], "agent_id": agent["id"], **loc})
    await broadcast_agent(agent["id"])
    return {"ok": True}


@router.post("/deliveries/{delivery_id}/delivered")
async def mark_delivered(delivery_id: str, cash_paise: int = Form(0), agent: dict = Depends(agent_only)):
    """Marks the stop delivered (optionally with cash received now). No photo is needed."""
    db = get_db()
    d = await _stop(delivery_id, agent)
    if d["status"] != "pending":
        raise HTTPException(400, f"This stop is already marked {d['status']}")
    trip = await _active_trip(agent["id"])
    loc = (trip or {}).get("last_location")
    await db.deliveries.update_one({"id": delivery_id}, {"$set": {
        "status": "delivered", "delivered_at": now_iso(), "delivered_location": loc,
        "trip_id": (trip or {}).get("id")}})
    if d["payment_status"] == "cod_pending":
        await cod_add_due(d["user_id"], d["amount_paise"], delivery_id,
                          ", ".join(f"{i['name']} × {i['qty']}" for i in d["items"]))
    if d["kind"] == "order":
        await db.orders.update_one({"id": d["ref_id"]}, {"$set": {"status": "delivered", "delivered_at": now_iso()}})
    elif d["kind"] == "redelivery" and d.get("original_delivery_id"):
        orig = await db.deliveries.find_one({"id": d["original_delivery_id"]})
        if orig and orig["kind"] == "order":
            await db.orders.update_one({"id": orig["ref_id"]}, {"$set": {"status": "delivered", "delivered_at": now_iso()}})
    cash_paise = min(cash_paise, await cod_balance(d["user_id"]))  # never record more than is owed
    if cash_paise > 0:
        await _collect(d, agent, cash_paise, trip)
    await notify(d["user_id"], "Delivered",
                 f"Your {SLOT_LABEL[d['slot']]} delivery ({', '.join(i['name'] for i in d['items'])}) was delivered.",
                 "delivered", delivery_id, sms=True)
    await broadcast_agent(agent["id"])
    return clean(await db.deliveries.find_one({"id": delivery_id}))


async def _collect(d: dict, agent: dict, amount: int, trip: dict | None):
    await cod_collect(d["user_id"], agent["id"], amount, d["id"], (trip or {}).get("id", ""), d["date"])
    await get_db().deliveries.update_one({"id": d["id"]}, {"$inc": {"cod_collected_paise": amount}})
    await notify(d["user_id"], "Cash received", f"{rupees(amount)} received in cash by {agent.get('name') or 'your milk agent'}.",
                 "payment", d["id"])


@router.post("/deliveries/{delivery_id}/cash")
async def collect_cash(delivery_id: str, body: CashIn, agent: dict = Depends(agent_only)):
    d = await _stop(delivery_id, agent)
    due = await cod_balance(d["user_id"])
    if body.amount_paise > due:
        raise HTTPException(400, f"Only {rupees(due)} is due from this customer" if due > 0 else
                            "Nothing is due from this customer")
    await _collect(d, agent, body.amount_paise, await _active_trip(agent["id"]))
    return {"cod_due_paise": await cod_balance(d["user_id"]), "tally": await _tally(agent["id"], today_ist().isoformat())}


@router.post("/deliveries/{delivery_id}/skipped")
async def mark_skipped(delivery_id: str, agent: dict = Depends(agent_only)):
    db = get_db()
    d = await _stop(delivery_id, agent)
    if d["status"] != "pending":
        raise HTTPException(400, f"This stop is already marked {d['status']}")
    await db.deliveries.update_one({"id": delivery_id}, {"$set": {"status": "skipped", "skipped_at": now_iso()}})
    if d["payment_status"] == "paid":
        await wallet_credit(d["user_id"], d["amount_paise"], "skipped_delivery_credit", delivery_id,
                            f"Skipped delivery on {parse_date(d['date']).strftime('%d %b')}")
    if d["kind"] == "order":
        await db.orders.update_one({"id": d["ref_id"]}, {"$set": {"status": "cancelled", **(
            {"payment_status": "refunded_to_wallet"} if d["payment_status"] == "paid" else {})}})
    await notify(d["user_id"], "Delivery skipped", "Today's delivery was skipped at your request."
                 + (f" {rupees(d['amount_paise'])} credited to your wallet." if d["payment_status"] == "paid" else ""),
                 "warning", delivery_id)
    await broadcast_agent(agent["id"])
    return clean(await db.deliveries.find_one({"id": delivery_id}))


@router.post("/deliveries/{delivery_id}/failed")
async def mark_failed(delivery_id: str, body: FailIn, agent: dict = Depends(agent_only)):
    db = get_db()
    d = await _stop(delivery_id, agent)
    if d["status"] != "pending":
        raise HTTPException(400, f"This stop is already marked {d['status']}")
    reason = FAIL_TEXT[body.reason] + (f": {body.note}" if body.note else "")
    await db.deliveries.update_one({"id": delivery_id}, {"$set": {"status": "failed", "failure_reason": reason,
                                                                  "failed_at": now_iso()}})
    outcome = await handle_missed(d, FAIL_TEXT[body.reason])
    await db.deliveries.update_one({"id": delivery_id}, {"$set": {"missed_outcome": outcome}})
    await broadcast_agent(agent["id"])
    return clean(await db.deliveries.find_one({"id": delivery_id}))


@router.post("/trips/end")
async def end_trip(body: EndTripIn, agent: dict = Depends(agent_only)):
    db = get_db()
    trip = await _active_trip(agent["id"])
    if not trip:
        raise HTTPException(400, "No trip in progress")
    summary = await _tally(agent["id"], trip["date"])
    slot_pending = await db.deliveries.count_documents({"agent_id": agent["id"], "date": trip["date"],
                                                        "slot": trip["slot"], "status": "pending"})
    await db.trips.update_one({"id": trip["id"]}, {"$set": {
        "status": "ended", "ended_at": now_iso(), "summary": summary, "pending_left": slot_pending,
        "handoff_note": body.handoff_note, "cash_handed_over_paise": body.cash_handed_over_paise}})
    await broadcast_agent(agent["id"])
    return clean(await db.trips.find_one({"id": trip["id"]}))


@router.get("/summary")
async def summary(agent: dict = Depends(agent_only)):
    db = get_db()
    date = today_ist().isoformat()
    trips = [clean(t) async for t in db.trips.find({"agent_id": agent["id"], "date": date}).sort("started_at", 1)]
    collections = [clean(c) async for c in db.cod_ledger.find({"agent_id": agent["id"], "type": "collected", "date": date})]
    return {"date": date, "tally": await _tally(agent["id"], date), "trips": trips, "collections": collections}
