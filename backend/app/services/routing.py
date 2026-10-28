"""Daily route generation, missed-delivery handling and live tracking payloads."""
import logging
from datetime import date, timedelta

from pymongo.errors import DuplicateKeyError

from .. import config
from ..db import get_db
from ..utils import clean, haversine_km, new_id, next_cycle_date, now_iso, parse_date, rupees
from . import payments
from .core import (SLOT_LABEL, delivers_on, display_name, get_settings, unit_price, wallet_credit,
                   wallet_debit)
from .notify import notify
from .tracking import customer_watchers, eta_minutes, hub, signal_state

log = logging.getLogger("moonest.routing")


async def _agent_for_pincode(pincode: str) -> str | None:
    db = get_db()
    q = {"roles": "agent", "active": {"$ne": False}}
    if not config.DEMO_MODE:  # demo agents can't sign in then, so never give them stops
        q["id"] = {"$nin": list(config.DEMO_ACCOUNT_IDS)}
    a = await db.users.find_one({**q, "pincodes": pincode})
    if not a and config.DEMO_MODE:
        # Test areas (demo mode) go to the demo agent, else any active agent
        a = await db.users.find_one({"id": "u-agent-ravi", "roles": "agent", "active": {"$ne": False}}) or \
            await db.users.find_one({"roles": "agent", "active": {"$ne": False}})
    return a["id"] if a else None


async def _address(address_id: str) -> dict | None:
    return clean(await get_db().addresses.find_one({"id": address_id}))


def _sequence(stops: list[dict]) -> list[dict]:
    """Nearest-neighbour ordering from the depot (good enough for a single-city route)."""
    remaining = list(stops)
    lat, lng = config.DEPOT_LAT, config.DEPOT_LNG
    ordered = []
    while remaining:
        def dist(s):
            a = s["address"]
            if a.get("lat") is None:
                return 10_000
            return haversine_km(lat, lng, a["lat"], a["lng"])

        nxt = min(remaining, key=dist)
        remaining.remove(nxt)
        ordered.append(nxt)
        if nxt["address"].get("lat") is not None:
            lat, lng = nxt["address"]["lat"], nxt["address"]["lng"]
    return ordered


async def _charge_subscription(sub: dict, user: dict, amount: int, d: date) -> tuple[bool, dict]:
    """Prepaid subscriptions are charged when the route is generated (after cutoff)."""
    ref = f"sub:{sub['id']}:{d.isoformat()}"
    db = get_db()
    # Never charge the same delivery day twice (e.g. the demo run followed by the nightly run)
    if await db.wallet_ledger.find_one({"ref": ref, "type": "debit"}) or \
            await db.payments.find_one({"ref": ref, "purpose": "autopay_debit", "status": "paid"}):
        return True, {"payment_status": "paid", "charge": "already_charged"}
    if sub["payment_method"] == "wallet":
        entry = await wallet_debit(user["id"], amount, "subscription_delivery", ref,
                                   f"{sub['product_name']} × {sub['quantity']} on {d.strftime('%d %b')}")
        if not entry:
            return False, {"reason": "low_wallet_balance"}
        return True, {"payment_status": "paid", "charge": "wallet"}
    if sub["payment_method"] == "autopay":
        m = sub.get("mandate") or {}
        if m.get("status") != "active" or (str(m.get("token_id", "")).startswith("token_demo")
                                            and payments.mode() == "live"):
            return False, {"reason": "mandate_inactive"}
        try:
            res = await payments.charge_mandate(m["customer_id"], m["token_id"], amount, ref,
                                                user.get("phone", ""), user.get("email", ""))
        except Exception as e:  # gateway failure shouldn't block the rest of the route
            log.warning("AutoPay charge failed for %s: %s", sub["id"], e)
            return False, {"reason": "autopay_failed"}
        await get_db().payments.insert_one({
            "id": new_id(), "user_id": user["id"], "purpose": "autopay_debit", "amount_paise": amount,
            "ref": ref, "razorpay_payment_id": res.get("razorpay_payment_id"), "status": "paid",
            "demo": bool(res.get("demo")), "created_at": now_iso(),
        })
        return True, {"payment_status": "paid", "charge": "autopay"}
    return True, {"payment_status": "cod_pending", "charge": "cod"}


async def generate_routes(d: date, stamp: date | None = None) -> dict:
    """Build delivery stops for date `d` (both slots). Idempotent per (kind, ref, date).

    `stamp` puts the stops on another day's route (demo: try tomorrow's deliveries today).
    """
    db = get_db()
    route_day = (stamp or d).isoformat()
    created = skipped = 0
    stops_by_slot: dict[str, list[dict]] = {"morning": [], "evening": []}

    existing = set()
    # A stop already exists if it's on this route, or was pulled forward for day `d` by the demo run
    async for s in db.deliveries.find({"$or": [{"date": route_day}, {"for_date": d.isoformat()}]},
                                      {"kind": 1, "ref_id": 1, "status": 1}):
        if s["kind"] == "order" and s["status"] == "failed":
            continue  # a failed order that was rescheduled gets a new stop
        existing.add((s["kind"], s["ref_id"]))

    # Subscriptions
    async for sub in db.subscriptions.find({"status": "active"}):
        try:
            sub = clean(sub)
            if ("subscription", sub["id"]) in existing or not delivers_on(sub, d):
                continue
            # Pending address change takes effect from its effective date
            if sub.get("pending_address_id") and d >= parse_date(sub["pending_effective_date"]):
                await db.subscriptions.update_one({"id": sub["id"]}, {
                    "$set": {"address_id": sub["pending_address_id"]},
                    "$unset": {"pending_address_id": "", "pending_effective_date": ""}})
                sub["address_id"] = sub.pop("pending_address_id")
            user = clean(await db.users.find_one({"id": sub["user_id"]}))
            product = clean(await db.products.find_one({"id": sub["product_id"]}))
            plan = clean(await db.plans.find_one({"code": sub["plan_code"]})) or {}
            addr = await _address(sub["address_id"])
            if not (user and product and addr):
                continue
            amount = unit_price(product, plan) * sub["quantity"]
            sub["product_name"] = display_name(product)
            ok, info = await _charge_subscription(sub, user, amount, d)
            if not ok:
                skipped += 1
                msg = {
                    "low_wallet_balance": f"Your {SLOT_LABEL[sub['slot']]} delivery on {d.strftime('%d %b')} was skipped: "
                                          f"wallet balance is below {rupees(amount)}. Top up to resume.",
                    "mandate_inactive": "Your UPI AutoPay mandate isn't active, so tomorrow's delivery was skipped. "
                                        "Set it up again or switch to Wallet/COD.",
                    "autopay_failed": "AutoPay debit failed, so tomorrow's delivery was skipped. "
                                      "Please check your UPI app or switch to Wallet.",
                }[info["reason"]]
                await notify(user["id"], "Delivery skipped", msg, "warning", sub["id"], sms=True)
                continue
            stops_by_slot[sub["slot"]].append({
                "kind": "subscription", "ref_id": sub["id"], "user_id": user["id"],
                "customer_name": user.get("name", ""), "customer_phone": addr.get("contact_phone") or user.get("phone", ""),
                "address": addr, "slot": sub["slot"],
                "items": [{"product_id": product["id"], "name": display_name(product), "unit": product["unit"],
                           "qty": sub["quantity"], "price_paise": unit_price(product, plan)}],
                "amount_paise": amount, "payment_method": sub["payment_method"],
                "payment_status": info["payment_status"],
            })
        except Exception:  # one bad subscription must never stop the rest of the route
            log.exception("Skipping subscription %s while building %s", sub.get("id"), d)
            skipped += 1

    # One-off orders
    async for o in db.orders.find({"delivery_date": d.isoformat(), "status": "confirmed"}):
        o = clean(o)
        if ("order", o["id"]) in existing:
            continue
        user = clean(await db.users.find_one({"id": o["user_id"]}))
        stops_by_slot[o["slot"]].append({
            "kind": "order", "ref_id": o["id"], "user_id": o["user_id"],
            "customer_name": (user or {}).get("name", ""),
            "customer_phone": o["address"].get("contact_phone") or (user or {}).get("phone", ""),
            "address": o["address"], "slot": o["slot"], "items": o["items"],
            "amount_paise": o["total_paise"], "payment_method": o["payment_method"],
            "payment_status": o["payment_status"],
        })

    # Redeliveries scheduled from earlier failed stops
    async for r in db.redeliveries.find({"date": d.isoformat(), "done": False}):
        if ("redelivery", r["id"]) in existing:
            continue
        stop = dict(r["stop"])
        stop.update({"kind": "redelivery", "ref_id": r["id"], "original_delivery_id": r["delivery_id"]})
        stops_by_slot[stop["slot"]].append(stop)
        await db.redeliveries.update_one({"id": r["id"]}, {"$set": {"done": True}})

    for slot, stops in stops_by_slot.items():
        groups: dict[str | None, list[dict]] = {}
        for s in stops:
            s["agent_id"] = await _agent_for_pincode(s["address"]["pincode"])
            groups.setdefault(s["agent_id"], []).append(s)
        for agent_id, group in groups.items():
            start_seq = await db.deliveries.count_documents({"date": route_day, "slot": slot,
                                                             "agent_id": agent_id})
            for i, s in enumerate(_sequence(group)):
                s.update({"id": new_id(), "date": route_day, "for_date": d.isoformat(), "sequence": start_seq + i + 1,
                          "status": "pending", "cod_collected_paise": 0, "created_at": now_iso()})
                await db.deliveries.insert_one(s)
                if s["kind"] == "order":
                    await db.orders.update_one({"id": s["ref_id"]}, {"$set": {"delivery_id": s["id"]}})
                created += 1
    return {"date": route_day, "created": created, "skipped": skipped}


async def handle_missed(delivery: dict, reason_text: str):
    """Failed stop → wallet credit (default) or redeliver next slot, per customer preference."""
    db = get_db()
    user = clean(await db.users.find_one({"id": delivery["user_id"]})) or {}
    pref = user.get("missed_pref", "wallet_credit")
    prepaid = delivery.get("payment_status") == "paid"
    outcome = "none"

    if pref == "redeliver":
        # Next day, or the first day whose route isn't built yet if it's already past the cutoff
        nxt = max(parse_date(delivery["date"]) + timedelta(days=1), next_cycle_date(await settings_cutoff()))
        if delivery["kind"] != "order":  # orders are simply rescheduled below (one stop, one COD due)
            stop = {k: delivery[k] for k in ("user_id", "customer_name", "customer_phone", "address", "slot",
                                             "items", "amount_paise", "payment_method", "payment_status")}
            await db.redeliveries.insert_one({"id": new_id(), "delivery_id": delivery["id"], "date": nxt.isoformat(),
                                              "stop": stop, "done": False, "created_at": now_iso()})
        outcome = f"redeliver:{nxt.isoformat()}"
        body = (f"We couldn't deliver today ({reason_text}). We'll bring it on {nxt.strftime('%d %b')} "
                f"({SLOT_LABEL[delivery['slot']]}).")
    elif prepaid:
        await wallet_credit(delivery["user_id"], delivery["amount_paise"], "missed_delivery_credit",
                            delivery["id"], f"Missed delivery on {parse_date(delivery['date']).strftime('%d %b')}")
        outcome = "wallet_credit"
        body = f"We couldn't deliver today ({reason_text}). {rupees(delivery['amount_paise'])} has been credited to your wallet."
    else:
        body = f"We couldn't deliver today ({reason_text}). You won't be charged for it."

    if delivery["kind"] == "order":
        upd = {"status": "failed", "failure_reason": reason_text}
        if outcome == "wallet_credit":
            upd["payment_status"] = "refunded_to_wallet"
        if outcome.startswith("redeliver"):
            upd = {"status": "confirmed", "delivery_date": outcome.split(":")[1], "rescheduled": True}
            await db.orders.update_one({"id": delivery["ref_id"]}, {"$set": upd, "$unset": {"delivery_id": ""}})
        else:
            await db.orders.update_one({"id": delivery["ref_id"]}, {"$set": upd})
    await notify(delivery["user_id"], "Delivery missed", body, "warning", delivery["id"], sms=True)
    return outcome


# ---------------- live tracking ----------------
async def tracking_payload(delivery: dict) -> dict:
    db = get_db()
    trip = clean(await db.trips.find_one({"agent_id": delivery.get("agent_id"), "date": delivery["date"],
                                          "slot": delivery["slot"]}, sort=[("started_at", -1)]))
    agent = clean(await db.users.find_one({"id": delivery.get("agent_id")})) if delivery.get("agent_id") else None
    loc = (trip or {}).get("last_location")
    ahead = []
    if trip and trip["status"] == "active":
        async for s in db.deliveries.find({"date": delivery["date"], "slot": delivery["slot"],
                                           "agent_id": delivery["agent_id"], "status": "pending",
                                           "sequence": {"$lt": delivery["sequence"]}}):
            ahead.append(clean(s))
    return {
        "delivery_id": delivery["id"], "status": delivery["status"], "slot": delivery["slot"],
        "date": delivery["date"], "destination": {"lat": delivery["address"].get("lat"),
                                                  "lng": delivery["address"].get("lng")},
        "trip_status": (trip or {}).get("status", "not_started"),
        "agent": {"name": agent.get("name", "Milk agent")} if agent else None,
        "location": loc, **signal_state(loc), "stops_before_you": len(ahead),
        "eta_minutes": eta_minutes(loc, sorted(ahead, key=lambda s: s["sequence"]), delivery)
        if trip and trip["status"] == "active" and delivery["status"] == "pending" else None,
        "photo_url": delivery.get("photo_url"), "delivered_at": delivery.get("delivered_at"),
    }


async def generate_once(d: date, by: str) -> dict | None:
    """Build day `d`'s routes once (scheduler / first agent of the day). The claim is atomic, and released
    again if building fails, so a later attempt retries instead of leaving agents with an empty route."""
    db = get_db()
    key = d.isoformat()
    try:
        await db.route_runs.insert_one({"date": key, "at": now_iso(), "by": by, "status": "running"})
    except DuplicateKeyError:
        return None
    try:
        res = await generate_routes(d)
    except Exception:
        await db.route_runs.delete_one({"date": key, "status": "running"})
        raise
    await db.route_runs.update_one({"date": key}, {"$set": {"status": "done", "result": res}})
    return res


async def broadcast_agent(agent_id: str, extra: dict | None = None):
    """Push fresh tracking state to every customer watching this agent, and to the fleet view."""
    db = get_db()
    for ws, delivery_id in list(customer_watchers.get(agent_id, ())):
        d = clean(await db.deliveries.find_one({"id": delivery_id}))
        if not d:
            continue
        try:
            await ws.send_json({"type": "tracking", **(await tracking_payload(d))})
        except Exception:
            customer_watchers[agent_id].discard((ws, delivery_id))
    agent = await db.users.find_one({"id": agent_id}, {"name": 1})
    trip = clean(await db.trips.find_one({"agent_id": agent_id}, sort=[("started_at", -1)]))
    await hub.publish("fleet", {"type": "fleet", "agent_id": agent_id, "name": (agent or {}).get("name"),
                                "trip": trip, **(extra or {})})


async def settings_cutoff() -> int:
    return int((await get_settings())["skip_cutoff_hour"])
