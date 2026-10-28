import hashlib
import re
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request

from .. import config
from ..db import get_db
from ..schemas import LoginIn, OtpRequest, OtpVerify, ProfileUpdate, RegisterIn
from ..security import create_token, current_user
from ..services.core import cod_balance, wallet_balance
from ..services.notify import send_sms
from ..services.passwords import check_not_locked, clear_failures, hash_password, record_failure, verify_password
from ..utils import PHONE_RE, clean, new_id, now_ist, now_iso

router = APIRouter(prefix="/api/auth", tags=["auth"])

OTP_TTL = timedelta(minutes=5)
RESEND_AFTER = timedelta(seconds=30)
MAX_ATTEMPTS = 5


def _key(body: OtpRequest) -> tuple[str, str]:
    if body.phone:
        return "phone", body.phone
    if body.email:
        return "email", body.email.lower()
    raise HTTPException(422, "Enter your 10-digit mobile number or email")


def _hash(code: str) -> str:
    return hashlib.sha256(f"{config.JWT_SECRET}:{code}".encode()).hexdigest()


def public_user(u: dict) -> dict:
    return {k: u.get(k) for k in ("id", "name", "username", "phone", "email", "roles", "role", "missed_pref",
                                  "pincodes", "created_at")}


@router.post("/request-otp")
async def request_otp(body: OtpRequest):
    db = get_db()
    field, value = _key(body)
    if body.role == "admin":
        raise HTTPException(403, "Admins sign in with username and password")
    if body.role != "customer":
        u = await db.users.find_one({field: value, "roles": body.role})
        if not u:
            who = "milk agent" if body.role == "agent" else "admin"
            raise HTTPException(403, f"This number isn't registered as a {who}. Please contact MooNest support.")
    prev = await db.otps.find_one({"key": value})
    if prev and now_ist() - datetime.fromisoformat(prev["sent_at"]) < RESEND_AFTER:
        raise HTTPException(429, "Please wait 30 seconds before requesting another OTP")
    code = f"{secrets.randbelow(10**6):06d}"
    await db.otps.delete_many({"key": value})
    await db.otps.insert_one({"key": value, "hash": _hash(code), "attempts": 0, "sent_at": now_iso(),
                              "expires_at": (now_ist() + OTP_TTL).isoformat()})
    sent = False
    if field == "phone":
        sent = await send_sms(value, f"{code} is your MooNest login OTP. It expires in 5 minutes.")
    resp = {"sent": True, "channel": field, "expires_in": int(OTP_TTL.total_seconds())}
    if config.DEMO_MODE and not sent:
        resp["dev_otp"] = code  # shown on the login screen only in demo mode
    return resp


@router.post("/verify-otp")
async def verify_otp(body: OtpVerify):
    db = get_db()
    field, value = _key(body)
    if body.role == "admin":
        raise HTTPException(403, "Admins sign in with username and password")
    rec = await db.otps.find_one({"key": value})
    if not rec or now_ist() > datetime.fromisoformat(rec["expires_at"]):
        raise HTTPException(400, "OTP expired. Please request a new one.")
    if rec["attempts"] >= MAX_ATTEMPTS:
        raise HTTPException(429, "Too many wrong attempts. Please request a new OTP.")
    if not secrets.compare_digest(rec["hash"], _hash(body.code)):
        await db.otps.update_one({"key": value}, {"$inc": {"attempts": 1}})
        raise HTTPException(400, "Incorrect OTP")
    await db.otps.delete_many({"key": value})

    user = clean(await db.users.find_one({field: value}))
    if user and not config.DEMO_MODE and user["id"] in config.DEMO_ACCOUNT_IDS:
        raise HTTPException(403, "Demo accounts are switched off")
    if body.role != "customer" and (not user or body.role not in user.get("roles", [])):
        raise HTTPException(403, "Not registered for this role")
    is_new = False
    if not user:
        is_new = True
        user = {"id": new_id(), "name": (body.name or "").strip(), field: value, "roles": ["customer"],
                "wallet_paise": 0, "missed_pref": "wallet_credit", "created_at": now_iso()}
        await db.users.insert_one(dict(user))
    elif body.role == "customer" and "customer" not in user["roles"]:
        await db.users.update_one({"id": user["id"]}, {"$addToSet": {"roles": "customer"}})
        user["roles"].append("customer")
    if body.name and not user.get("name"):
        await db.users.update_one({"id": user["id"]}, {"$set": {"name": body.name.strip()}})
        user["name"] = body.name.strip()
    user["role"] = body.role
    return {"token": create_token(user["id"], body.role), "user": public_user(user), "is_new": is_new}


@router.post("/register")
async def register(body: RegisterIn):
    """Email + mobile + password sign-up. Agents can self-register only in demo mode (otherwise admin adds them)."""
    db = get_db()
    if body.role == "agent" and not config.DEMO_MODE:
        raise HTTPException(403, "Milk agents are added by MooNest. Please contact support.")
    email = body.email.lower()
    if await db.users.find_one({"email": email}):
        raise HTTPException(409, "An account with this email already exists. Sign in instead.")
    if await db.users.find_one({"phone": body.phone}):
        raise HTTPException(409, "This mobile number is already registered. Sign in instead.")
    user = {"id": new_id(), "name": body.name.strip(), "email": email, "phone": body.phone, "roles": [body.role],
            "wallet_paise": 0, "missed_pref": "wallet_credit", "password_hash": hash_password(body.password),
            "created_at": now_iso()}
    if body.role == "agent":
        user.update(pincodes=[], active=True)
    await db.users.insert_one(dict(user))
    user["role"] = body.role
    return {"token": create_token(user["id"], body.role), "user": public_user(user), "is_new": True}


@router.post("/login")
async def login(body: LoginIn, request: Request):
    db = get_db()
    ident = body.identifier.strip().lower()
    digits = "".join(ch for ch in ident if ch.isdigit())[-10:]
    if "@" in ident:
        query = {"email": ident}
    elif re.fullmatch(r"[\d\s+()-]+", ident) and PHONE_RE.match(digits):
        query = {"phone": digits}
    else:
        query = {"username": ident}
    # Lockout is per account AND network address, so a stranger guessing can't lock the real person out
    key = f"login:{next(iter(query.values()))}:{request.client.host if request.client else '-'}"
    await check_not_locked(key)
    user = clean(await db.users.find_one(query))
    if not user or not verify_password(body.password, user.get("password_hash")):
        await record_failure(key)
        raise HTTPException(400, "Email or password is incorrect")
    await clear_failures(key)
    if not config.DEMO_MODE and user["id"] in config.DEMO_ACCOUNT_IDS:
        raise HTTPException(403, "Demo accounts are switched off")
    if body.role not in user.get("roles", []):
        raise HTTPException(403, {"agent": "This account isn't registered as a milk agent",
                                  "admin": "This account isn't an admin"}.get(body.role, "Use the Milk Agent tab to sign in"))
    user["role"] = body.role
    return {"token": create_token(user["id"], body.role), "user": public_user(user), "is_new": False}


@router.get("/me")
async def me(user: dict = Depends(current_user)):
    out = public_user(user)
    out["wallet_paise"] = await wallet_balance(user["id"])
    out["cod_due_paise"] = await cod_balance(user["id"])
    out["needs_phone"] = not user.get("phone")
    return out


@router.patch("/me")
async def update_me(body: ProfileUpdate, user: dict = Depends(current_user)):
    db = get_db()
    upd = body.model_dump(exclude_none=True)
    if "phone" in upd and await db.users.find_one({"phone": upd["phone"], "id": {"$ne": user["id"]}}):
        raise HTTPException(409, "This mobile number is already linked to another account")
    if "email" in upd:
        upd["email"] = upd["email"].lower()
        if await db.users.find_one({"email": upd["email"], "id": {"$ne": user["id"]}}):
            raise HTTPException(409, "This email is already linked to another account")
    if upd:
        await db.users.update_one({"id": user["id"]}, {"$set": upd})
    u = clean(await db.users.find_one({"id": user["id"]}))
    u["role"] = user["role"]
    return public_user(u)
