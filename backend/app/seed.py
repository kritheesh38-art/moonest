"""Seed reference data (settings, plans, areas, catalogue), demo accounts (optional) and the admins.

Ids are fixed and match the in-browser build, and seeding only inserts what's missing, so it is
safe to run on every start. Prices or products edited in Admin are never overwritten.
"""
import json
import logging
from pathlib import Path

from pymongo.errors import DuplicateKeyError

from . import config
from . import db as _db
from .db import close_sandbox, get_db, open_sandbox, real_db
from .services.core import DEFAULT_SETTINGS
from .services.passwords import hash_password
from .utils import now_iso

log = logging.getLogger("moonest.seed")

CATALOGUE_FILE = Path(__file__).parent / "data" / "catalogue.json"

PLANS = [
    {"id": "plan-daily", "code": "daily", "name": "Daily", "description": "Fresh milk every single day.",
     "discount_pct": 5, "perks": ["5% off every delivery", "Skip any day before 10 PM", "Vacation pause up to 30 days"],
     "sort": 1},
    {"id": "plan-alternate", "code": "alternate", "name": "Alternate Day", "description": "Delivered every other day.",
     "discount_pct": 3, "perks": ["3% off every delivery", "Great for smaller households", "Skip or pause anytime"],
     "sort": 2},
    {"id": "plan-custom", "code": "custom", "name": "Custom Days", "description": "Choose the weekdays that suit you.",
     "discount_pct": 0, "perks": ["Pick any weekdays", "Change days anytime", "No lock-in"], "sort": 3},
]

AREAS = [
    {"pincode": "560034", "name": "Koramangala", "lat": 12.9352, "lng": 77.6245},
    {"pincode": "560095", "name": "Koramangala 6th Block", "lat": 12.9390, "lng": 77.6190},
    {"pincode": "560102", "name": "HSR Layout", "lat": 12.9116, "lng": 77.6474},
    {"pincode": "560038", "name": "Indiranagar", "lat": 12.9719, "lng": 77.6412},
    {"pincode": "560068", "name": "Bommanahalli", "lat": 12.9081, "lng": 77.6233},
    {"pincode": "560076", "name": "BTM Layout", "lat": 12.9166, "lng": 77.6101},
]

DEMO_PASSWORD = "pass1234"
DEMO_USERS = [
    {"id": "u-agent-ravi", "name": "Ravi Kumar", "phone": "9000000001", "email": "agent@moonest.in", "roles": ["agent"],
     "pincodes": ["560034", "560095", "560068", "560076"], "active": True},
    {"id": "u-agent-suresh", "name": "Suresh N", "phone": "9000000002", "roles": ["agent"],
     "pincodes": ["560102", "560038"], "active": True},
    {"id": "u-demo-customer", "name": "Aditi Rao", "phone": "9811122233", "email": "customer@moonest.in",
     "roles": ["customer"], "wallet_paise": 50000, "missed_pref": "wallet_credit"},
]


def load_catalogue() -> list[dict]:
    return json.loads(CATALOGUE_FILE.read_text())


async def _insert(coll, doc: dict):
    """Insert seed data, ignoring a copy another starting server instance just inserted."""
    try:
        await coll.insert_one(doc)
    except DuplicateKeyError:
        log.info("Seed: %s already present", doc.get("id") or doc.get("code") or doc.get("pincode"))


async def seed(demo_accounts: bool = True, db=None):
    db = db if db is not None else get_db()
    t = now_iso()
    if not await db.settings.find_one({"key": "global"}):
        await _insert(db.settings, dict(DEFAULT_SETTINGS))
    for p in PLANS:
        if not await db.plans.find_one({"code": p["code"]}):
            await _insert(db.plans, {"active": True, **p})
    for a in AREAS:
        if not await db.areas.find_one({"pincode": a["pincode"]}):
            await _insert(db.areas, {"id": a["pincode"], **a, "active": True})
    for i, p in enumerate(load_catalogue()):
        if not await db.products.find_one({"id": p["id"]}):
            await _insert(db.products, {**p, "active": True, "sort": i, "created_at": t})
    if demo_accounts:
        pw = hash_password(DEMO_PASSWORD)
        for u in DEMO_USERS:
            if await db.users.find_one({"$or": [{"id": u["id"]}, {"phone": u["phone"]}]}):
                continue
            await _insert(db.users, {"wallet_paise": 0, **u, **({"password_hash": pw} if u.get("email") else {}),
                                     "created_at": t})
    await bootstrap_admin(db)  # last, so it also removes admin from any older demo admin account


async def set_demo_mode(on: bool, save: bool = True):
    """Demo mode on: the app switches to a throwaway in-memory copy of the real data, with the demo
    accounts added. Off: the copy is dropped and the app is back on the saved data, untouched."""
    if save:
        await real_db().settings.update_one({"key": "global"}, {"$set": {"demo_mode": on}}, upsert=True)
    if on == config.DEMO_MODE and (not on or _db._sandbox is not None):
        return  # already there; keep the current demo copy
    if on:
        sandbox = await open_sandbox()  # requests keep using the real data until the copy is ready
        await seed(demo_accounts=config.SEED_DEMO_DATA, db=sandbox)
    config.DEMO_MODE = on
    if not on:
        close_sandbox()


async def remove_demo_accounts():
    """The demo accounts live only in demo mode's copy; clear any saved in the real data by older versions."""
    db = real_db()
    ids = list(config.DEMO_ACCOUNT_IDS)
    for name in await db.list_collection_names():
        if name != "users":
            await db[name].delete_many({"user_id": {"$in": ids}})
    await db.users.delete_many({"id": {"$in": ids}})


async def bootstrap_admin(db=None):
    """Make exactly the ADMIN_USERS accounts admins, with ADMIN_PASSWORD (re-applied on every start)."""
    db = db if db is not None else get_db()
    # Only the listed accounts keep admin, whatever else is configured
    await db.users.update_many({"roles": "admin", "username": {"$nin": config.ADMIN_USERS}}, {"$pull": {"roles": "admin"}})
    if not config.ADMIN_USERS:
        return
    if not config.ADMIN_PASSWORD:
        # Keep the app up for customers and agents; nobody can use Admin until the password is set
        log.error("ADMIN_PASSWORD is not set: Admin sign-in is disabled. Set it in your host's environment and restart.")
        await db.users.update_many({"username": {"$in": config.ADMIN_USERS}}, {"$unset": {"password_hash": ""}})
        return
    if len(config.ADMIN_PASSWORD) < 8:
        log.warning("ADMIN_PASSWORD is shorter than 8 characters; sign-in lockout still applies")
    pw = hash_password(config.ADMIN_PASSWORD)
    for name in config.ADMIN_USERS:
        if await db.users.find_one({"username": name}):
            await db.users.update_one({"username": name}, {"$set": {"password_hash": pw}, "$addToSet": {"roles": "admin"}})
        else:
            await _insert(db.users, {"id": f"u-admin-{name}", "username": name, "name": name.capitalize(),
                                     "roles": ["admin"], "wallet_paise": 0, "password_hash": pw, "created_at": now_iso()})
