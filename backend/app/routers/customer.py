import random
from datetime import timedelta
from html import escape

from fastapi import APIRouter, Depends, HTTPException, Path
from fastapi.responses import HTMLResponse

from ..db import get_db
from ..schemas import AddressIn, OrderIn, RazorpayVerify, TopupIn
from ..security import current_user, customer_only
from ..services import payments
from ..services.core import (SLOT_LABEL, cod_balance, display_name, get_settings, serviceable, wallet_balance,
                             wallet_credit, wallet_debit)
from ..services.notify import notify
from ..services.routing import tracking_payload
from ..utils import clean, new_id, next_cycle_date, now_iso, parse_date, rupees, today_ist

router = APIRouter(prefix="/api", tags=["customer"])


# ---------------- addresses ----------------
def _place(addr: dict, area: dict):
    """Without a GPS pin, spread the home around the area centre (~600 m) so routes and ETAs stay realistic."""
    if addr.get("lat") is None or addr.get("lng") is None:
        addr["lat"] = area["lat"] + (random.random() - 0.5) * 0.012
        addr["lng"] = area["lng"] + (random.random() - 0.5) * 0.012
        addr["approx_location"] = True


@router.get("/addresses")
async def list_addresses(user: dict = Depends(customer_only)):
    return [clean(a) async for a in get_db().addresses.find({"user_id": user["id"], "deleted": {"$ne": True}})]


@router.post("/addresses", status_code=201)
async def add_address(body: AddressIn, user: dict = Depends(customer_only)):
    db = get_db()
    area = await serviceable(body.pincode)
    if not area:
        raise HTTPException(400, f"Sorry, we don't deliver to {body.pincode} yet.")
    addr = body.model_dump()
    _place(addr, area)
    addr.update({"id": new_id(), "user_id": user["id"], "area": area["name"], "created_at": now_iso()})
    if addr["is_default"] or not await db.addresses.count_documents({"user_id": user["id"], "deleted": {"$ne": True}}):
        await db.addresses.update_many({"user_id": user["id"]}, {"$set": {"is_default": False}})
        addr["is_default"] = True
    await db.addresses.insert_one(dict(addr))
    return addr


@router.put("/addresses/{address_id}")
async def update_address(address_id: str, body: AddressIn, user: dict = Depends(customer_only)):
    db = get_db()
    cur = await db.addresses.find_one({"id": address_id, "user_id": user["id"]})
    if not cur:
        raise HTTPException(404, "Address not found")
    area = await serviceable(body.pincode)
    if not area:
        raise HTTPException(400, f"Sorry, we don't deliver to {body.pincode} yet.")
    upd = body.model_dump()
    if upd["lat"] is None and cur.get("pincode") == body.pincode:  # keep the existing pin for the same area
        upd["lat"], upd["lng"] = cur.get("lat"), cur.get("lng")
    _place(upd, area)
    upd["area"] = area["name"]
    if upd["is_default"]:
        await db.addresses.update_many({"user_id": user["id"]}, {"$set": {"is_default": False}})
    await db.addresses.update_one({"id": address_id}, {"$set": upd})
    return clean(await db.addresses.find_one({"id": address_id}))


@router.delete("/addresses/{address_id}")
async def delete_address(address_id: str, user: dict = Depends(customer_only)):
    db = get_db()
    in_use = await db.subscriptions.find_one({"user_id": user["id"], "status": {"$in": ["active", "pending_mandate"]},
                                              "$or": [{"address_id": address_id}, {"pending_address_id": address_id}]})
    if in_use:
        raise HTTPException(400, "This address is used by an active subscription. Change the subscription address first.")
    await db.addresses.update_one({"id": address_id, "user_id": user["id"]}, {"$set": {"deleted": True}})
    return {"ok": True}


async def _owned_address(address_id: str, user_id: str) -> dict:
    a = clean(await get_db().addresses.find_one({"id": address_id, "user_id": user_id, "deleted": {"$ne": True}}))
    if not a:
        raise HTTPException(400, "Please choose a delivery address")
    if not await serviceable(a["pincode"]):
        raise HTTPException(400, f"Sorry, we don't deliver to {a['pincode']} anymore.")
    return a


# ---------------- orders ----------------
async def _price_cart(items) -> tuple[list[dict], int]:
    db = get_db()
    lines, subtotal = [], 0
    for it in items:
        p = clean(await db.products.find_one({"id": it.product_id, "active": True}))
        if not p:
            raise HTTPException(400, "One of the products in your cart is no longer available")
        lines.append({"product_id": p["id"], "name": display_name(p), "unit": p["unit"], "qty": it.qty,
                      "price_paise": p["price_paise"], "line_total_paise": p["price_paise"] * it.qty,
                      "image": p.get("image", "")})
        subtotal += p["price_paise"] * it.qty
    return lines, subtotal


@router.post("/orders/quote")
async def quote(body: OrderIn, user: dict = Depends(customer_only)):
    s = await get_settings()
    lines, subtotal = await _price_cart(body.items)
    fee = 0 if subtotal >= s["free_delivery_above_paise"] else s["delivery_fee_paise"]
    return {"items": lines, "subtotal_paise": subtotal, "delivery_fee_paise": fee, "total_paise": subtotal + fee}


@router.post("/orders", status_code=201)
async def place_order(body: OrderIn, user: dict = Depends(customer_only)):
    db = get_db()
    s = await get_settings()
    cutoff = int(s["skip_cutoff_hour"])
    d = parse_date(body.delivery_date)
    earliest = next_cycle_date(cutoff)
    if d < earliest:
        raise HTTPException(400, f"Earliest delivery date is {earliest.strftime('%d %b %Y')} "
                                 f"(orders close at {cutoff}:00 the night before)")
    if d > today_ist() + timedelta(days=30):
        raise HTTPException(400, "You can order up to 30 days ahead")
    addr = await _owned_address(body.address_id, user["id"])
    if not (addr.get("contact_phone") or user.get("phone")):
        raise HTTPException(400, "Add a 10-digit mobile number so the milk agent can reach you")
    lines, subtotal = await _price_cart(body.items)
    fee = 0 if subtotal >= s["free_delivery_above_paise"] else s["delivery_fee_paise"]
    total = subtotal + fee
    order = {
        "id": new_id(), "number": f"MN{now_iso()[2:10].replace('-', '')}{new_id()[:4].upper()}",
        "user_id": user["id"], "items": lines, "subtotal_paise": subtotal, "delivery_fee_paise": fee,
        "total_paise": total, "address": addr, "slot": body.slot, "delivery_date": body.delivery_date,
        "payment_method": body.payment_method, "note": body.note, "created_at": now_iso(),
        "status": "pending", "payment_status": "pending",
    }
    resp: dict = {}
    if body.payment_method == "cod":
        order.update(status="confirmed", payment_status="cod_pending")
    elif body.payment_method == "wallet":
        entry = await wallet_debit(user["id"], total, "order_payment", order["id"], f"Order {order['number']}")
        if not entry:
            bal = await wallet_balance(user["id"])
            raise HTTPException(402, f"Wallet balance {rupees(bal)} is less than {rupees(total)}. Top up or choose another method.")
        order.update(status="confirmed", payment_status="paid")
    else:
        rzp = await payments.create_order(total, order["id"], {"order_number": order["number"]})
        pay = {"id": new_id(), "user_id": user["id"], "purpose": "order", "ref": order["id"],
               "amount_paise": total, "razorpay_order_id": rzp["id"], "status": "created",
               "demo": bool(rzp.get("demo")), "created_at": now_iso()}
        await db.payments.insert_one(dict(pay))
        order["razorpay_order_id"] = rzp["id"]
        resp["payment"] = {"payment_id": pay["id"], "razorpay_order_id": rzp["id"], "amount_paise": total,
                           "demo": pay["demo"]}
    await db.orders.insert_one(dict(order))
    if order["status"] == "confirmed":
        await _order_confirmed_notice(order)
    resp["order"] = order
    return resp


async def _order_confirmed_notice(order: dict):
    when = parse_date(order["delivery_date"]).strftime("%a, %d %b")
    await notify(order["user_id"], "Order confirmed",
                 f"Order {order['number']} ({rupees(order['total_paise'])}) will arrive {when}, "
                 f"{SLOT_LABEL[order['slot']]}.", "order", order["id"], sms=True)


@router.post("/payments/verify")
async def verify_payment(body: RazorpayVerify, user: dict = Depends(customer_only)):
    """Confirms a Razorpay checkout (order, wallet top-up or AutoPay mandate)."""
    db = get_db()
    pay = clean(await db.payments.find_one({"id": body.payment_id, "user_id": user["id"]}))
    if not pay:
        raise HTTPException(404, "Payment not found")
    if pay["status"] == "paid":
        return {"status": "paid", "already": True}

    if pay.get("demo"):
        if payments.mode() != "demo":
            raise HTTPException(400, "Demo payments are disabled")
        ok = body.demo_outcome == "success"
        rzp_payment_id = f"pay_demo_{pay['id'][:10]}" if ok else None
    else:
        ok = bool(body.razorpay_order_id == pay["razorpay_order_id"] and body.razorpay_payment_id and
                  payments.verify_signature(pay["razorpay_order_id"], body.razorpay_payment_id,
                                            body.razorpay_signature or ""))
        rzp_payment_id = body.razorpay_payment_id

    if not ok:
        await db.payments.update_one({"id": pay["id"], "status": {"$ne": "paid"}}, {"$set": {"status": "failed"}})
        if pay["purpose"] == "order":
            await db.orders.update_one({"id": pay["ref"], "payment_status": {"$ne": "paid"}},
                                       {"$set": {"payment_status": "failed"}})
        return {"status": "failed", "message": "Payment failed or was cancelled. You can retry or pick another method."}

    token_id = ""
    if pay["purpose"] == "mandate":
        token_id = f"token_demo_{pay['id'][:10]}"
        if not pay.get("demo"):  # look the token up first, so a gateway hiccup leaves the payment retryable
            try:
                token_id = (await payments.fetch_payment(rzp_payment_id)).get("token_id", "")
            except Exception:
                raise HTTPException(502, "Couldn't confirm AutoPay with the bank. Please try again in a minute.")
            if not token_id:
                raise HTTPException(502, "AutoPay wasn't authorised by the bank. Please try again.")

    # Claim the payment atomically: two overlapping confirmations can't both credit or confirm
    claimed = await db.payments.find_one_and_update(
        {"id": pay["id"], "status": {"$ne": "paid"}},
        {"$set": {"status": "paid", "razorpay_payment_id": rzp_payment_id, "method": body.method,
                  "method_detail": body.method_detail, "paid_at": now_iso()}})
    if not claimed:
        return {"status": "paid", "already": True}

    if pay["purpose"] == "order":
        order = clean(await db.orders.find_one({"id": pay["ref"]}))
        if order and order["status"] == "cancelled":  # cancelled while paying: give the money back
            await wallet_credit(user["id"], pay["amount_paise"], "refund", order["id"],
                                f"Refund for cancelled order {order['number']}")
            await db.orders.update_one({"id": order["id"]}, {"$set": {"payment_status": "refunded_to_wallet"}})
            return {"status": "paid", "refunded_to_wallet": True}
        upd = {"status": "confirmed", "payment_status": "paid", "razorpay_payment_id": rzp_payment_id}
        # Paid after that day's orders closed (or its route was already built): move to the next open day
        if order:
            day = max(parse_date(order["delivery_date"]), next_cycle_date(int((await get_settings())["skip_cutoff_hour"])))
            while await db.route_runs.find_one({"date": day.isoformat()}):
                day += timedelta(days=1)
            if day.isoformat() != order["delivery_date"]:
                upd.update(delivery_date=day.isoformat(), rescheduled=True)
        await db.orders.update_one({"id": pay["ref"]}, {"$set": upd})
        await _order_confirmed_notice(clean(await db.orders.find_one({"id": pay["ref"]})))
    elif pay["purpose"] == "topup":
        await wallet_credit(user["id"], pay["amount_paise"], "topup", pay["id"], "Wallet top-up")
    elif pay["purpose"] == "mandate":
        await db.subscriptions.update_one({"id": pay["ref"]}, {"$set": {
            "status": "active", "mandate.status": "active", "mandate.token_id": token_id,
            "mandate.activated_at": now_iso()}})
        await notify(user["id"], "UPI AutoPay active", "Your subscription is live. Deliveries will be auto-debited.",
                     "subscription", pay["ref"])
    return {"status": "paid"}


@router.post("/orders/{order_id}/retry-payment")
async def retry_payment(order_id: str, user: dict = Depends(customer_only)):
    db = get_db()
    o = clean(await db.orders.find_one({"id": order_id, "user_id": user["id"]}))
    if not o or o["status"] != "pending" or o["payment_method"] != "razorpay":
        raise HTTPException(400, "This order doesn't need payment")
    rzp = await payments.create_order(o["total_paise"], o["id"], {"order_number": o["number"]})
    pay = {"id": new_id(), "user_id": user["id"], "purpose": "order", "ref": o["id"], "amount_paise": o["total_paise"],
           "razorpay_order_id": rzp["id"], "status": "created", "demo": bool(rzp.get("demo")), "created_at": now_iso()}
    await db.payments.insert_one(dict(pay))
    await db.orders.update_one({"id": o["id"]}, {"$set": {"razorpay_order_id": rzp["id"], "payment_status": "pending"}})
    return {"payment_id": pay["id"], "razorpay_order_id": rzp["id"], "amount_paise": o["total_paise"], "demo": pay["demo"]}


@router.get("/orders")
async def my_orders(user: dict = Depends(customer_only)):
    return [clean(o) async for o in get_db().orders.find({"user_id": user["id"]}).sort("created_at", -1)]


@router.get("/orders/{order_id}")
async def order_detail(order_id: str, user: dict = Depends(customer_only)):
    db = get_db()
    o = clean(await db.orders.find_one({"id": order_id, "user_id": user["id"]}))
    if not o:
        raise HTTPException(404, "Order not found")
    if o.get("delivery_id"):
        dlv = clean(await db.deliveries.find_one({"id": o["delivery_id"]}))
        if dlv:
            o["delivery"] = {k: dlv.get(k) for k in ("status", "photo_url", "delivered_at", "failure_reason")}
    s = await get_settings()
    o["can_cancel"] = o["status"] in ("pending", "confirmed") and not o.get("delivery_id") and \
        parse_date(o["delivery_date"]) >= next_cycle_date(int(s["skip_cutoff_hour"]))
    return o


@router.post("/orders/{order_id}/cancel")
async def cancel_order(order_id: str, user: dict = Depends(customer_only)):
    db = get_db()
    o = await order_detail(order_id, user)
    if not o["can_cancel"]:
        raise HTTPException(400, "This order can no longer be cancelled")
    # Atomic: of two overlapping cancels only one matches, so the refund happens once
    before = await db.orders.find_one_and_update(
        {"id": order_id, "user_id": user["id"], "status": {"$in": ["pending", "confirmed"]},
         "delivery_id": {"$exists": False}},
        {"$set": {"status": "cancelled", "cancelled_at": now_iso()}})
    if not before:
        raise HTTPException(400, "This order can no longer be cancelled")
    if before.get("payment_status") == "paid":
        await wallet_credit(user["id"], o["total_paise"], "refund", o["id"], f"Refund for order {o['number']}")
        await db.orders.update_one({"id": order_id}, {"$set": {"payment_status": "refunded_to_wallet"}})
    await notify(user["id"], "Order cancelled", f"Order {o['number']} was cancelled."
                 + (" Amount refunded to your wallet." if o["payment_status"] == "paid" else ""), "order", order_id)
    return await order_detail(order_id, user)


# ---------------- wallet ----------------
@router.get("/wallet")
async def wallet(user: dict = Depends(customer_only)):
    db = get_db()
    ledger = [clean(e) async for e in db.wallet_ledger.find({"user_id": user["id"]}).sort("created_at", -1).limit(200)]
    cod = [clean(e) async for e in db.cod_ledger.find({"user_id": user["id"]}).sort("created_at", -1).limit(100)]
    pays = [clean(p) async for p in db.payments.find({"user_id": user["id"]}).sort("created_at", -1).limit(100)]
    return {"balance_paise": await wallet_balance(user["id"]), "cod_due_paise": await cod_balance(user["id"]),
            "ledger": ledger, "cod_ledger": cod, "payments": pays}


@router.post("/wallet/topup")
async def topup(body: TopupIn, user: dict = Depends(customer_only)):
    db = get_db()
    pay_id = new_id()
    rzp = await payments.create_order(body.amount_paise, pay_id, {"purpose": "wallet_topup"})
    pay = {"id": pay_id, "user_id": user["id"], "purpose": "topup", "ref": "", "amount_paise": body.amount_paise,
           "razorpay_order_id": rzp["id"], "status": "created", "demo": bool(rzp.get("demo")), "created_at": now_iso()}
    await db.payments.insert_one(dict(pay))
    return {"payment_id": pay_id, "razorpay_order_id": rzp["id"], "amount_paise": body.amount_paise, "demo": pay["demo"]}


@router.get("/invoices")
async def invoices(user: dict = Depends(customer_only)):
    months: dict[str, dict] = {}
    async for dl in get_db().deliveries.find({"user_id": user["id"], "status": "delivered"}):
        m = dl["date"][:7]
        inv = months.setdefault(m, {"id": m, "month": m, "deliveries": 0, "amount_paise": 0})
        inv["deliveries"] += 1
        inv["amount_paise"] += dl["amount_paise"]
    return sorted(months.values(), key=lambda x: x["month"], reverse=True)


@router.get("/invoices/{month}")
async def invoice(month: str = Path(pattern=r"^\d{4}-\d{2}$"), format: str = "json",
                  user: dict = Depends(customer_only)):
    """Monthly invoice as JSON (shown in the app), or `?format=html` for a printable page."""
    deliveries = [d async for d in get_db().deliveries.find({"user_id": user["id"], "status": "delivered",
                                                              "date": {"$regex": f"^{month}"}}).sort("date", 1)]
    if not deliveries:
        raise HTTPException(404, "No deliveries in this month")
    lines = []
    for d in deliveries:
        for i in d["items"]:
            lines.append({"date": d["date"], "slot": SLOT_LABEL[d["slot"]], "name": i["name"], "unit": i["unit"],
                          "qty": i["qty"], "rate_paise": i["price_paise"], "amount_paise": i["price_paise"] * i["qty"],
                          "paid_via": d["payment_method"]})
        fee = d["amount_paise"] - sum(i["price_paise"] * i["qty"] for i in d["items"])
        if fee > 0:  # one-off orders below the free-delivery amount
            lines.append({"date": d["date"], "slot": SLOT_LABEL[d["slot"]], "name": "Delivery fee", "unit": "",
                          "qty": 1, "rate_paise": fee, "amount_paise": fee, "paid_via": d["payment_method"]})
    if format != "html":
        return {"month": month, "customer": {"name": user.get("name"), "phone": user.get("phone")},
                "lines": lines, "total_paise": sum(d["amount_paise"] for d in deliveries)}
    rows = [f"<tr><td>{x['date']}</td><td>{x['slot']}</td><td>{escape(x['name'])}"
            f"{' (' + escape(x['unit']) + ')' if x['unit'] else ''}</td><td>{x['qty']}</td><td>{rupees(x['rate_paise'])}</td>"
            f"<td>{rupees(x['amount_paise'])}</td><td>{x['paid_via'].upper()}</td></tr>" for x in lines]
    total = sum(d["amount_paise"] for d in deliveries)
    return HTMLResponse(f"""<!doctype html><html><head><meta charset=utf-8><title>MooNest invoice {month}</title>
<style>body{{font-family:system-ui;margin:32px;color:#1f2a24}}table{{border-collapse:collapse;width:100%}}
td,th{{border-bottom:1px solid #ddd;padding:8px;text-align:left;font-size:14px}}h1{{color:#2f6b4f}}</style></head>
<body><h1>MooNest</h1><p>Invoice for <b>{month}</b><br>{escape(user.get('name') or '')} · +91 {user.get('phone') or ''}</p>
<table><tr><th>Date</th><th>Slot</th><th>Item</th><th>Qty</th><th>Rate</th><th>Amount</th><th>Paid via</th></tr>
{''.join(rows)}<tr><th colspan=5>Total</th><th colspan=2>{rupees(total)}</th></tr></table>
<p style="color:#777;font-size:12px">Milk and fresh dairy are GST-exempt. Generated {now_iso()[:10]}.</p>
<script>window.print&&setTimeout(()=>window.print(),300)</script></body></html>""")


# ---------------- notifications + tracking ----------------
@router.get("/notifications")
async def notifications(user: dict = Depends(current_user)):
    return [clean(n) async for n in get_db().notifications.find({"user_id": user["id"]}).sort("created_at", -1).limit(50)]


@router.post("/notifications/read")
async def mark_read(user: dict = Depends(current_user)):
    await get_db().notifications.update_many({"user_id": user["id"], "read": False}, {"$set": {"read": True}})
    return {"ok": True}


@router.get("/tracking/today")
async def tracking_today(user: dict = Depends(customer_only)):
    """Today's deliveries for this customer with agent location + ETA (REST fallback for the WebSocket)."""
    out = []
    async for d in get_db().deliveries.find({"user_id": user["id"], "date": today_ist().isoformat()}).sort("slot", 1):
        d = clean(d)
        payload = await tracking_payload(d)
        payload["items"] = d["items"]
        out.append(payload)
    return out
