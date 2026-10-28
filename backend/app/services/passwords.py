"""Password hashing (PBKDF2-SHA256, standard library only) and sign-in throttling."""
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta

from fastapi import HTTPException

from ..db import get_db
from ..utils import now_ist

ITERATIONS = 240_000
MAX_FAILURES = 5
LOCK_FOR = timedelta(minutes=15)


def hash_password(password: str, *, salt: str | None = None, iterations: int = ITERATIONS) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), iterations).hex()
    return f"pbkdf2_sha256${iterations}${salt}${digest}"


def verify_password(password: str, stored: str | None) -> bool:
    try:
        algo, iterations, salt, digest = (stored or "").split("$")
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False
    check = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations)).hex()
    return hmac.compare_digest(check, digest)


async def check_not_locked(key: str):
    rec = await get_db().login_failures.find_one({"key": key})
    if rec and rec.get("locked_until") and now_ist() < datetime.fromisoformat(rec["locked_until"]):
        raise HTTPException(429, "Too many wrong attempts. Try again in 15 minutes or sign in with an OTP.")


async def record_failure(key: str):
    db = get_db()
    rec = await db.login_failures.find_one_and_update({"key": key}, {"$inc": {"count": 1}}, upsert=True,
                                                      return_document=True)
    if rec and rec.get("count", 0) >= MAX_FAILURES:
        await db.login_failures.update_one({"key": key}, {"$set": {
            "count": 0, "locked_until": (now_ist() + LOCK_FOR).isoformat()}})


async def clear_failures(key: str):
    await get_db().login_failures.delete_many({"key": key})
