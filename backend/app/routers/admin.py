import re

from fastapi import APIRouter, Depends, HTTPException

from .. import config

from ..db import get_db
from ..seed import set_demo_mode
from ..schemas import (AgentIn, AgentPasswordIn, AreaIn, AssignIn, GenerateIn, PlanUpdate, ProductIn, ProductUpdate,
                       RefundIn, SettingsUpdate)
from ..security import admin_only
from ..services.core import cod_balance, get_settings, wallet_credit
from ..services.notify import notify
from ..services.passwords import hash_password
from ..services import geocode, stats
from ..services.pickup import pickup_list
from ..services.routing import _sequence, generate_routes
from ..utils import clean, new_id, next_cycle_date, now_iso, parse_date, rupees, today_ist

router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(admin_only)])


@router.get("/overview")
async def overview(date: str | None = None):
    db = get_db()
    date = date or today_ist().isoformat()
    counts = {"pending": 0, "delivered": 0, "skipped": 0, "failed": 0}
    revenue = 0
    async for d in db.deliveries.find({"date": date}):
        counts[d["status"]] = counts.get(d["status"], 0) + 1
        if d["status"] == "delivered":
            revenue += d["amount_paise"]
    unassigned = await db.deliveries.count_documents({"date": date, "agent_id": None})
    return {
        "date": date, "deliveries": counts, "unassigned": unassigned, "delivered_value_paise": revenue,
        "active_subscriptions": await db.subscriptions.count_documents({"status": "active"}),
        "customers": await db.users.count_documents({"roles": "customer"}),
        "agents": await db.users.count_documents({"roles": "agent"}),
        "active_trips": await db.trips.count_documents({"status": "active", "date": today_ist().isoformat()}),
        "orders_today": await db.orders.count_documents({"created_at": {"$regex": f"^{today_ist().isoformat()}"}}),
    }


@router.get("/stats")
async def dashboard_stats(days: int = 30):
    """Daily litres, revenue, deliveries and new customers, top brands and cash owed (for the charts)."""
    return await stats.dashboard(today_ist(), max(7, min(days, 90)))


@router.get("/pickup")
async def pickup(date: str | None = None):
    """Packets each agent collects from the dairy for a day."""
    return await pickup_list(parse_date(date) if date else today_ist())


# ---- catalogue ----
@router.get("/products")
async def all_products():
    return [clean(p) async for p in get_db().products.find({}).sort("sort", 1)]


@router.post("/products", status_code=201)
async def create_product(body: ProductIn):
    p = {"id": new_id(), **body.model_dump(exclude_none=True), "mrp_paise": body.mrp_paise, "sort": 100,
         "created_at": now_iso()}
    if body.subscribable is None:
        p["subscribable"] = body.category == "milk"
    await get_db().products.insert_one(dict(p))
    return p


@router.put("/products/{product_id}")
async def update_product(product_id: str, body: ProductUpdate):
    db = get_db()
    # An explicit null clears an optional field (e.g. MRP); required fields ignore nulls
    clearable = {"mrp_paise", "group", "pack_label", "pack_color", "fat"}
    upd = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None or k in clearable}
    if not upd:
        raise HTTPException(422, "Nothing to update")
    r = await db.products.update_one({"id": product_id}, {"$set": upd})
    if not r.matched_count:
        raise HTTPException(404, "Product not found")
    return clean(await db.products.find_one({"id": product_id}))


@router.get("/plans")
async def all_plans():
    return [clean(p) async for p in get_db().plans.find({}).sort("sort", 1)]


@router.put("/plans/{plan_id}")
async def update_plan(plan_id: str, body: PlanUpdate):
    db = get_db()
    r = await db.plans.update_one({"id": plan_id}, {"$set": body.model_dump(exclude_none=True)})
    if not r.matched_count:
        raise HTTPException(404, "Plan not found")
    return clean(await db.plans.find_one({"id": plan_id}))


@router.get("/settings")
async def settings():
    temporary = config.MONGO_URL.startswith("mongomock://")
    storage = "demo" if config.DEMO_MODE else "temporary" if temporary else "permanent"
    return {**await get_settings(), "demo_mode": config.DEMO_MODE, "storage": storage}


@router.put("/settings")
async def update_settings(body: SettingsUpdate):
    upd = body.model_dump(exclude_none=True)
    if "city" in upd:
        upd["city"] = upd["city"].strip()
    demo = upd.pop("demo_mode", None)
    if demo is not None:
        await set_demo_mode(demo)  # takes effect immediately for every request
    if upd:  # saved only when demo mode is off
        await get_db().settings.update_one({"key": "global"}, {"$set": upd}, upsert=True)
    return await settings()


@router.get("/areas")
async def all_areas():
    return [clean(a) async for a in get_db().areas.find({})]


@router.post("/areas", status_code=201)
async def add_area(body: AreaIn):
    db = get_db()
    area = body.model_dump()
    if area["lat"] is None or area["lng"] is None:  # not given: the pincode's centre
        area.update(await geocode.pincode_centre(body.pincode))
    await db.areas.update_one({"pincode": body.pincode}, {"$set": {"id": body.pincode, **area, "active": True}},
                              upsert=True)
    return clean(await db.areas.find_one({"pincode": body.pincode}))


@router.post("/areas/{pincode}/toggle")
async def toggle_area(pincode: str):
    db = get_db()
    a = await db.areas.find_one({"pincode": pincode})
    if not a:
        raise HTTPException(404, "Area not found")
    await db.areas.update_one({"pincode": pincode}, {"$set": {"active": not a.get("active", True)}})
    return clean(await db.areas.find_one({"pincode": pincode}))


# ---- agents ----
@router.get("/agents")
async def agents():
    out = []
    hidden = [] if config.DEMO_MODE else list(config.DEMO_ACCOUNT_IDS)  # demo agents only exist in demo mode
    async for a in get_db().users.find({"roles": "agent", "id": {"$nin": hidden}}):
        a = clean(a)
        out.append({**{k: a.get(k) for k in ("id", "name", "phone", "email", "pincodes", "active")},
                    "has_password": bool(a.get("password_hash"))})
    return out


@router.post("/agents", status_code=201)
async def create_agent(body: AgentIn):
    db = get_db()
    existing = clean(await db.users.find_one({"phone": body.phone}))
    login = await _agent_login(body.email, body.password, existing["id"] if existing else None)
    if existing and "agent" in existing.get("roles", []):
        await db.users.update_one({"id": existing["id"]}, {"$set": {"pincodes": body.pincodes, "active": True, **login}})
        return _agent_view(clean(await db.users.find_one({"id": existing["id"]})))
    if existing:
        # Phone numbers on customer profiles aren't verified, so never hand agent access to that account
        raise HTTPException(409, f"{body.phone} is already on a customer account ({existing.get('name') or 'no name'}). "
                                 "Use a different number for the agent, or ask the customer to remove it from their profile.")
    u = {"id": new_id(), "name": body.name, "phone": body.phone, "roles": ["agent"], "pincodes": body.pincodes,
         "active": True, "wallet_paise": 0, "created_at": now_iso(), **login}
    await db.users.insert_one(dict(u))
    return _agent_view(u)


async def _agent_login(email: str | None, password: str | None, own_id: str | None) -> dict:
    """Email + password for an agent's sign-in (no SMS needed)."""
    out: dict = {}
    if email:
        email = email.lower()
        if await get_db().users.find_one({"email": email, "id": {"$ne": own_id}}):
            raise HTTPException(409, f"{email} is already used by another account")
        out["email"] = email
    if password:
        out["password_hash"] = hash_password(password)
    return out


def _agent_view(u: dict) -> dict:
    return {**{k: u.get(k) for k in ("id", "name", "phone", "email", "pincodes", "active", "roles")},
            "has_password": bool(u.get("password_hash"))}


@router.post("/agents/{agent_id}/password")
async def set_agent_password(agent_id: str, body: AgentPasswordIn):
    """Give an agent (or change their) email + password sign-in."""
    db = get_db()
    a = await db.users.find_one({"id": agent_id, "roles": "agent"})
    if not a:
        raise HTTPException(404, "Agent not found")
    login = await _agent_login(body.email or a.get("email"), body.password, agent_id)
    if not login.get("email"):
        raise HTTPException(422, "Add an email for the agent to sign in with")
    await db.users.update_one({"id": agent_id}, {"$set": login})
    return _agent_view(clean(await db.users.find_one({"id": agent_id})))


@router.put("/agents/{agent_id}")
async def update_agent(agent_id: str, body: AgentIn):
    db = get_db()
    if await db.users.find_one({"phone": body.phone, "id": {"$ne": agent_id}}):
        raise HTTPException(409, f"{body.phone} is already used by another account")
    r = await db.users.update_one({"id": agent_id, "roles": "agent"},
                                  {"$set": {"name": body.name, "phone": body.phone, "pincodes": body.pincodes}})
    if not r.matched_count:
        raise HTTPException(404, "Agent not found")
    return clean(await db.users.find_one({"id": agent_id}))


# ---- routes ----
@router.get("/routes")
async def routes(date: str | None = None, slot: str | None = None):
    db = get_db()
    q = {"date": date or today_ist().isoformat()}
    if slot:
        q["slot"] = slot
    return [clean(d) async for d in db.deliveries.find(q).sort([("slot", 1), ("agent_id", 1), ("sequence", 1)])]


@router.post("/routes/generate")
async def generate(body: GenerateIn):
    db = get_db()
    if parse_date(body.date) < today_ist():
        raise HTTPException(400, "Routes can only be built for today or a later day")
    await db.route_runs.update_one({"date": body.date}, {"$set": {"date": body.date, "at": now_iso(), "by": "admin"}},
                                   upsert=True)
    return await generate_routes(parse_date(body.date))


@router.post("/demo/run-tomorrow-today")
async def run_tomorrow_today():
    """Demo helper: build the next delivery day's stops onto today's route so the whole flow can be tried now."""
    if not config.DEMO_MODE:
        raise HTTPException(403, "Only available in demo mode")
    db = get_db()
    today = today_ist()
    await db.route_runs.update_one({"date": today.isoformat()}, {"$set": {"date": today.isoformat(), "at": now_iso(),
                                                                          "by": "demo"}}, upsert=True)
    cutoff = int((await get_settings())["skip_cutoff_hour"])
    return await generate_routes(next_cycle_date(cutoff), stamp=today)


@router.post("/routes/assign")
async def assign(body: AssignIn):
    db = get_db()
    agent = await db.users.find_one({"id": body.agent_id, "roles": "agent"})
    if not agent:
        raise HTTPException(404, "Agent not found")
    stops = [clean(d) async for d in db.deliveries.find({"id": {"$in": body.delivery_ids}, "status": "pending"})]
    if not stops:
        raise HTTPException(400, "No pending stops selected")
    for s in stops:
        await db.deliveries.update_one({"id": s["id"]}, {"$set": {"agent_id": body.agent_id}})
    # Re-sequence the agent's pending stops per (date, slot)
    for date, slot in {(s["date"], s["slot"]) for s in stops}:
        pend = [clean(d) async for d in db.deliveries.find({"date": date, "slot": slot, "agent_id": body.agent_id,
                                                             "status": "pending"})]
        done = await db.deliveries.count_documents({"date": date, "slot": slot, "agent_id": body.agent_id,
                                                    "status": {"$ne": "pending"}})
        for i, s in enumerate(_sequence(pend)):
            await db.deliveries.update_one({"id": s["id"]}, {"$set": {"sequence": done + i + 1}})
    return {"assigned": len(stops)}


@router.get("/fleet")
async def fleet():
    db = get_db()
    out = []
    async for t in db.trips.find({"status": "active", "date": today_ist().isoformat()}):
        t = clean(t)
        a = await db.users.find_one({"id": t["agent_id"]}, {"name": 1, "phone": 1})
        pending = await db.deliveries.count_documents({"agent_id": t["agent_id"], "date": t["date"],
                                                       "slot": t["slot"], "status": "pending"})
        out.append({**t, "name": (a or {}).get("name"), "phone": (a or {}).get("phone"), "pending": pending})
    return out


# ---- COD reconciliation ----
@router.get("/cod")
async def cod():
    db = get_db()
    by_agent: dict[str, dict] = {}
    async for e in db.cod_ledger.find({"type": "collected", "reconciled": False}):
        a = by_agent.setdefault(e["agent_id"], {"id": e["agent_id"], "agent_id": e["agent_id"], "amount_paise": 0,
                                                "entries": 0})
        a["amount_paise"] += e["amount_paise"]
        a["entries"] += 1
    for a in by_agent.values():
        u = await db.users.find_one({"id": a["agent_id"]}, {"name": 1})
        a["name"] = (u or {}).get("name")
        handed = 0
        async for t in db.trips.find({"agent_id": a["agent_id"], "status": "ended", "reconciled": {"$ne": True}}):
            handed += t.get("cash_handed_over_paise", 0)
        a["declared_handover_paise"] = handed
    dues = []
    for uid in await db.cod_ledger.distinct("user_id"):
        bal = await cod_balance(uid)
        if bal > 0:
            u = await db.users.find_one({"id": uid}, {"name": 1, "phone": 1})
            dues.append({"user_id": uid, "name": (u or {}).get("name"), "phone": (u or {}).get("phone"), "due_paise": bal})
    return {"agents": list(by_agent.values()), "customer_dues": sorted(dues, key=lambda x: -x["due_paise"])}


@router.post("/cod/reconcile/{agent_id}")
async def reconcile(agent_id: str):
    db = get_db()
    r = await db.cod_ledger.update_many({"agent_id": agent_id, "type": "collected", "reconciled": False},
                                        {"$set": {"reconciled": True, "reconciled_at": now_iso()}})
    await db.trips.update_many({"agent_id": agent_id, "status": "ended"}, {"$set": {"reconciled": True}})
    return {"reconciled_entries": r.modified_count}


# ---- customers, refunds, subscriptions ----
@router.get("/customers")
async def customers(q: str = ""):
    db = get_db()
    filt: dict = {"roles": "customer"}
    if q:
        pattern = re.escape(q.strip()[:60])
        filt["$or"] = [{"phone": {"$regex": pattern}}, {"name": {"$regex": pattern, "$options": "i"}},
                       {"email": {"$regex": pattern, "$options": "i"}}]
    out = []
    async for u in db.users.find(filt).limit(100):
        out.append({k: u.get(k) for k in ("id", "name", "phone", "email", "wallet_paise", "created_at")}
                   | {"cod_due_paise": await cod_balance(u["id"])})
    return out


@router.post("/customers/{user_id}/refund")
async def refund(user_id: str, body: RefundIn):
    db = get_db()
    if not await db.users.find_one({"id": user_id}):
        raise HTTPException(404, "Customer not found")
    entry = await wallet_credit(user_id, body.amount_paise, "refund", "", body.reason)
    await notify(user_id, "Refund issued", f"{rupees(body.amount_paise)} credited to your wallet: {body.reason}",
                 "payment", entry["id"], sms=True)
    return entry


@router.get("/orders")
async def orders(status: str | None = None):
    q = {"status": status} if status else {}
    return [clean(o) async for o in get_db().orders.find(q).sort("created_at", -1).limit(200)]


@router.get("/subscriptions")
async def subscriptions(status: str | None = None):
    db = get_db()
    q = {"status": status} if status else {"status": {"$ne": "cancelled"}}
    out = []
    async for s in db.subscriptions.find(q).sort("created_at", -1).limit(300):
        s = clean(s)
        u = await db.users.find_one({"id": s["user_id"]}, {"name": 1, "phone": 1})
        p = await db.products.find_one({"id": s["product_id"]}, {"name": 1})
        out.append({**s, "customer": {"name": (u or {}).get("name"), "phone": (u or {}).get("phone")},
                    "product_name": (p or {}).get("name")})
    return out


@router.post("/subscriptions/{sub_id}/toggle-pause")
async def toggle_pause(sub_id: str):
    db = get_db()
    s = await db.subscriptions.find_one({"id": sub_id})
    if not s or s["status"] not in ("active", "paused"):
        raise HTTPException(400, "Only active or paused subscriptions can be toggled")
    new = "paused" if s["status"] == "active" else "active"
    await db.subscriptions.update_one({"id": sub_id}, {"$set": {"status": new}})
    await notify(s["user_id"], "Subscription " + ("paused" if new == "paused" else "resumed"),
                 "MooNest support has " + ("paused" if new == "paused" else "resumed") + " your subscription.",
                 "subscription", sub_id)
    return clean(await db.subscriptions.find_one({"id": sub_id}))
