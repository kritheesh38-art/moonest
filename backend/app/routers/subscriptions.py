from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException

from ..db import get_db
from ..schemas import AddressChangeIn, PauseIn, SkipIn, SubscriptionIn, SubscriptionUpdate
from ..security import customer_only
from ..services import payments
from ..services.core import (SLOT_LABEL, display_name, get_settings, paused_on, plan_by_code, serviceable,
                             unit_price, upcoming_dates, wallet_balance, wallet_credit)
from ..services.notify import notify
from ..utils import clean, new_id, next_cycle_date, now_iso, parse_date, rupees, today_ist

router = APIRouter(prefix="/api/subscriptions", tags=["subscriptions"])


async def _cutoff() -> int:
    return int((await get_settings())["skip_cutoff_hour"])


async def _get(sub_id: str, user_id: str) -> dict:
    s = clean(await get_db().subscriptions.find_one({"id": sub_id, "user_id": user_id}))
    if not s:
        raise HTTPException(404, "Subscription not found")
    return s


async def _view(sub: dict) -> dict:
    db = get_db()
    cutoff = await _cutoff()
    product = clean(await db.products.find_one({"id": sub["product_id"]})) or {}
    plan = clean(await db.plans.find_one({"code": sub["plan_code"]})) or {}
    addr = clean(await db.addresses.find_one({"id": sub["address_id"]}))
    pending = clean(await db.addresses.find_one({"id": sub["pending_address_id"]})) if sub.get("pending_address_id") else None
    price = unit_price(product, plan) if product else 0
    start = max(today_ist(), parse_date(sub["start_date"]))
    upcoming = upcoming_dates(sub, start, 14)
    month_count = sum(1 for x in upcoming_dates(sub, start, 30) if x["state"] == "scheduled")
    pause_now = paused_on(sub, today_ist())
    display_status = "paused" if sub["status"] == "active" and pause_now else sub["status"]
    return {**sub, "product": product, "plan": plan, "address": addr, "pending_address": pending,
            "unit_price_paise": price, "per_delivery_paise": price * sub["quantity"],
            "est_monthly_paise": price * sub["quantity"] * month_count, "upcoming": upcoming,
            "display_status": display_status, "slot_label": SLOT_LABEL[sub["slot"]],
            "next_editable_date": next_cycle_date(cutoff).isoformat(), "cutoff_hour": cutoff}


def _validate_custom(plan_code: str, days: list[int]):
    if plan_code == "custom" and not days:
        raise HTTPException(422, "Pick at least one delivery day for a custom plan")


@router.get("")
async def list_subs(user: dict = Depends(customer_only)):
    out = []
    async for s in get_db().subscriptions.find({"user_id": user["id"], "status": {"$ne": "draft"}}).sort("created_at", -1):
        out.append(await _view(clean(s)))
    return out


@router.get("/{sub_id}")
async def get_sub(sub_id: str, user: dict = Depends(customer_only)):
    return await _view(await _get(sub_id, user["id"]))


@router.post("", status_code=201)
async def create_sub(body: SubscriptionIn, user: dict = Depends(customer_only)):
    db = get_db()
    _validate_custom(body.plan_code, body.custom_days)
    plan = await plan_by_code(body.plan_code)
    product = clean(await db.products.find_one({"id": body.product_id, "active": True}))
    if not product or not product.get("subscribable", True):
        raise HTTPException(400, "This product isn't available for subscription")
    addr = clean(await db.addresses.find_one({"id": body.address_id, "user_id": user["id"], "deleted": {"$ne": True}}))
    if not addr or not await serviceable(addr["pincode"]):
        raise HTTPException(400, "Please choose a serviceable delivery address")
    if not (addr.get("contact_phone") or user.get("phone")):
        raise HTTPException(400, "Add a 10-digit mobile number so the milk agent can reach you")
    earliest = next_cycle_date(await _cutoff())
    if parse_date(body.start_date) < earliest:
        raise HTTPException(400, f"Earliest start date is {earliest.strftime('%d %b %Y')}")
    per_delivery = unit_price(product, plan) * body.quantity
    if body.payment_method == "wallet" and await wallet_balance(user["id"]) < per_delivery:
        raise HTTPException(402, f"Top up at least {rupees(per_delivery)} to start a wallet subscription")

    sub = {"id": new_id(), "user_id": user["id"], **body.model_dump(), "skips": [], "pauses": [],
           "status": "active", "created_at": now_iso()}
    resp: dict = {}
    if body.payment_method == "autopay":
        if not user.get("phone"):
            raise HTTPException(400, "UPI AutoPay needs a 10-digit mobile number on your profile")
        customer_id = await payments.create_customer(user.get("name", ""), user["phone"], user.get("email", ""))
        max_amount = max(per_delivery * 2, 500_00)
        rzp = await payments.create_mandate_order(customer_id, max_amount, sub["id"])
        pay = {"id": new_id(), "user_id": user["id"], "purpose": "mandate", "ref": sub["id"], "amount_paise": rzp["amount"],
               "razorpay_order_id": rzp["id"], "status": "created", "demo": bool(rzp.get("demo")), "created_at": now_iso()}
        await db.payments.insert_one(dict(pay))
        sub["status"] = "pending_mandate"
        sub["mandate"] = {"status": "pending", "customer_id": customer_id, "max_amount_paise": max_amount}
        resp["payment"] = {"payment_id": pay["id"], "razorpay_order_id": rzp["id"], "amount_paise": rzp["amount"],
                           "demo": pay["demo"], "customer_id": customer_id, "recurring": True}
    await db.subscriptions.insert_one(dict(sub))
    if sub["status"] == "active":
        await notify(user["id"], "Subscription started",
                     f"{display_name(product)} × {body.quantity}, {plan['name']}, from "
                     f"{parse_date(body.start_date).strftime('%d %b')} at {SLOT_LABEL[body.slot]}.",
                     "subscription", sub["id"], sms=True)
    resp["subscription"] = await _view(sub)
    return resp


@router.patch("/{sub_id}")
async def update_sub(sub_id: str, body: SubscriptionUpdate, user: dict = Depends(customer_only)):
    db = get_db()
    sub = await _get(sub_id, user["id"])
    if sub["status"] == "cancelled":
        raise HTTPException(400, "This subscription is cancelled")
    upd = body.model_dump(exclude_none=True)
    if "plan_code" in upd:
        await plan_by_code(upd["plan_code"])
    if "custom_days" in upd:
        upd["custom_days"] = sorted({d for d in upd["custom_days"] if 0 <= d <= 6})
    _validate_custom(upd.get("plan_code", sub["plan_code"]), upd.get("custom_days", sub.get("custom_days", [])))
    if upd.get("plan_code") == "alternate" and sub["plan_code"] != "alternate":
        # Alternate days count from the next editable date
        upd["start_date"] = max(parse_date(sub["start_date"]), next_cycle_date(await _cutoff())).isoformat()
    if upd.get("payment_method") == "autopay" and (sub.get("mandate") or {}).get("status") != "active":
        raise HTTPException(400, "Set up UPI AutoPay by creating a new subscription with AutoPay, or use Wallet/COD")
    if sub["status"] == "pending_mandate" and upd.get("payment_method") in ("wallet", "cod"):
        upd["status"] = "active"  # customer gave up on AutoPay and picked another method
        upd["start_date"] = max(parse_date(sub["start_date"]), next_cycle_date(await _cutoff())).isoformat()
    if upd:
        await db.subscriptions.update_one({"id": sub_id}, {"$set": upd})
    return await _view(await _get(sub_id, user["id"]))


@router.post("/{sub_id}/skip")
async def skip_day(sub_id: str, body: SkipIn, user: dict = Depends(customer_only)):
    await set_skip(sub_id, user["id"], body.date, body.skip)
    return await _view(await _get(sub_id, user["id"]))


async def set_skip(sub_id: str, user_id: str, day: str, skip: bool = True):
    """Skip (or un-skip) one delivery day, until the nightly cutoff before it. Also used by the
    "Skip tomorrow" button on the evening reminder."""
    db = get_db()
    await _get(sub_id, user_id)
    cutoff = await _cutoff()
    d = parse_date(day)
    if d < next_cycle_date(cutoff):
        raise HTTPException(400, f"Changes for {d.strftime('%d %b')} closed at {cutoff}:00 the night before")
    op = "$addToSet" if skip else "$pull"
    await db.subscriptions.update_one({"id": sub_id}, {op: {"skips": day}})
    if skip:
        # The stop may already be built (e.g. the admin generated that day early): remove it and refund
        q = {"kind": "subscription", "ref_id": sub_id, "status": "pending",
             "$or": [{"date": day}, {"for_date": day}]}
        async for stop in db.deliveries.find(q):
            if (await db.deliveries.delete_one({"id": stop["id"], "status": "pending"})).deleted_count and \
                    stop.get("payment_status") == "paid":
                await wallet_credit(user_id, stop["amount_paise"], "skipped_delivery_credit", stop["id"],
                                    f"Skipped delivery on {d.strftime('%d %b')}")


@router.post("/{sub_id}/pause")
async def pause(sub_id: str, body: PauseIn, user: dict = Depends(customer_only)):
    db = get_db()
    sub = await _get(sub_id, user["id"])
    s = await get_settings()
    start, end = parse_date(body.start_date), parse_date(body.end_date)
    if end < start:
        raise HTTPException(422, "End date must be on or after start date")
    if (end - start).days + 1 > int(s["max_pause_days"]):
        raise HTTPException(422, f"Vacation pause can be at most {s['max_pause_days']} days")
    if start < next_cycle_date(int(s["skip_cutoff_hour"])):
        raise HTTPException(400, f"Pause can start from {next_cycle_date(int(s['skip_cutoff_hour'])).strftime('%d %b')}")
    for p in sub.get("pauses", []):
        if not (end < parse_date(p["start_date"]) or start > parse_date(p["end_date"])):
            raise HTTPException(400, "This overlaps an existing pause")
    pause_rec = {"id": new_id(), "start_date": body.start_date, "end_date": body.end_date, "created_at": now_iso()}
    await db.subscriptions.update_one({"id": sub_id}, {"$push": {"pauses": pause_rec}})
    resume = (end + timedelta(days=1)).strftime("%d %b")
    await notify(user["id"], "Vacation pause set",
                 f"Deliveries and billing paused {start.strftime('%d %b')} – {end.strftime('%d %b')}. Auto-resumes {resume}.",
                 "subscription", sub_id)
    return await _view(await _get(sub_id, user["id"]))


@router.delete("/{sub_id}/pause/{pause_id}")
async def cancel_pause(sub_id: str, pause_id: str, user: dict = Depends(customer_only)):
    db = get_db()
    sub = await _get(sub_id, user["id"])
    cutoff = await _cutoff()
    nxt = next_cycle_date(cutoff)
    p = next((p for p in sub.get("pauses", []) if p["id"] == pause_id), None)
    if not p:
        raise HTTPException(404, "Pause not found")
    if parse_date(p["end_date"]) < nxt:
        raise HTTPException(400, "This pause has already ended")
    if parse_date(p["start_date"]) >= nxt:
        await db.subscriptions.update_one({"id": sub_id}, {"$pull": {"pauses": {"id": pause_id}}})
    else:  # resume early: end the pause the day before the next editable date
        await db.subscriptions.update_one({"id": sub_id, "pauses.id": pause_id},
                                          {"$set": {"pauses.$.end_date": (nxt - timedelta(days=1)).isoformat()}})
    return await _view(await _get(sub_id, user["id"]))


@router.post("/{sub_id}/address")
async def change_address(sub_id: str, body: AddressChangeIn, user: dict = Depends(customer_only)):
    db = get_db()
    sub = await _get(sub_id, user["id"])
    addr = clean(await db.addresses.find_one({"id": body.address_id, "user_id": user["id"], "deleted": {"$ne": True}}))
    if not addr:
        raise HTTPException(404, "Address not found")
    if not await serviceable(addr["pincode"]):
        raise HTTPException(400, f"Sorry, we don't deliver to {addr['pincode']} yet. Your current address stays active.")
    if not (addr.get("contact_phone") or user.get("phone")):
        raise HTTPException(400, "Add a 10-digit mobile number so the milk agent can reach you")
    if addr["id"] == sub["address_id"]:
        await db.subscriptions.update_one({"id": sub_id}, {"$unset": {"pending_address_id": "", "pending_effective_date": ""}})
    else:
        eff = next_cycle_date(await _cutoff())
        await db.subscriptions.update_one({"id": sub_id}, {"$set": {"pending_address_id": addr["id"],
                                                                     "pending_effective_date": eff.isoformat()}})
        await notify(user["id"], "Address change scheduled",
                     f"Deliveries move to '{addr['label']}' from {eff.strftime('%d %b')}.", "subscription", sub_id)
    return await _view(await _get(sub_id, user["id"]))


@router.post("/{sub_id}/cancel")
async def cancel_sub(sub_id: str, user: dict = Depends(customer_only)):
    db = get_db()
    await _get(sub_id, user["id"])
    await db.subscriptions.update_one({"id": sub_id}, {"$set": {"status": "cancelled", "cancelled_at": now_iso()}})
    await notify(user["id"], "Subscription cancelled", "Your subscription has been cancelled. Already-scheduled "
                 "deliveries for the next cycle may still arrive.", "subscription", sub_id)
    return await _view(await _get(sub_id, user["id"]))


@router.post("/{sub_id}/resume")
async def resume_sub(sub_id: str, user: dict = Depends(customer_only)):
    db = get_db()
    sub = await _get(sub_id, user["id"])
    if sub["status"] != "cancelled":
        raise HTTPException(400, "Subscription is already active")
    if sub["payment_method"] == "autopay" and (sub.get("mandate") or {}).get("status") != "active":
        raise HTTPException(400, "AutoPay mandate is not active. Switch to Wallet or COD first.")
    start = max(parse_date(sub["start_date"]), next_cycle_date(await _cutoff()))
    await db.subscriptions.update_one({"id": sub_id}, {"$set": {"status": "active", "start_date": start.isoformat()}})
    return await _view(await _get(sub_id, user["id"]))


@router.post("/{sub_id}/mandate")
async def retry_mandate(sub_id: str, user: dict = Depends(customer_only)):
    """Restart UPI AutoPay authorisation for a subscription stuck in pending_mandate."""
    db = get_db()
    sub = await _get(sub_id, user["id"])
    if sub["status"] != "pending_mandate":
        raise HTTPException(400, "AutoPay is already set up for this subscription")
    m = sub["mandate"]
    rzp = await payments.create_mandate_order(m["customer_id"], m["max_amount_paise"], sub["id"])
    pay = {"id": new_id(), "user_id": user["id"], "purpose": "mandate", "ref": sub["id"], "amount_paise": rzp["amount"],
           "razorpay_order_id": rzp["id"], "status": "created", "demo": bool(rzp.get("demo")), "created_at": now_iso()}
    await db.payments.insert_one(dict(pay))
    return {"payment_id": pay["id"], "razorpay_order_id": rzp["id"], "amount_paise": rzp["amount"],
            "demo": pay["demo"], "customer_id": m["customer_id"], "recurring": True}
