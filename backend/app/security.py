from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from . import config
from .db import get_db
from .utils import clean

bearer = HTTPBearer(auto_error=False)
ROLES = ("customer", "agent", "admin")


def create_token(user_id: str, role: str) -> str:
    payload = {
        "sub": user_id,
        "role": role,
        "exp": datetime.now(timezone.utc) + timedelta(hours=config.JWT_TTL_HOURS),
    }
    return jwt.encode(payload, config.JWT_SECRET, algorithm="HS256")


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, config.JWT_SECRET, algorithms=["HS256"])
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired, please log in again")


async def user_from_token(token: str) -> dict:
    payload = decode_token(token)
    user = clean(await get_db().users.find_one({"id": payload["sub"]}))
    if not user or payload.get("role") not in user.get("roles", []):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired, please log in again")
    if not config.DEMO_MODE and user["id"] in config.DEMO_ACCOUNT_IDS:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Demo accounts are switched off")
    user["role"] = payload["role"]
    return user


async def current_user(creds: HTTPAuthorizationCredentials | None = Depends(bearer)) -> dict:
    if not creds:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Please log in")
    return await user_from_token(creds.credentials)


def require_role(*roles: str):
    async def dep(user: dict = Depends(current_user)) -> dict:
        if user["role"] not in roles:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "You don't have access to this")
        return user

    return dep


customer_only = require_role("customer")
agent_only = require_role("agent")
admin_only = require_role("admin")
