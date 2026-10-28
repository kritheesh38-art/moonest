import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import timedelta

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import config
from .db import connect, ensure_indexes, real_db
from .routers import admin, agent, auth, catalog, customer, push, subscriptions, ws
from .seed import remove_demo_accounts, seed, set_demo_mode
from .services.core import get_settings
from .services.reminders import send_once as send_reminders_once
from .services.routing import generate_once
from .utils import now_ist, now_iso

log = logging.getLogger("moonest")
logging.basicConfig(level=logging.INFO)


async def route_scheduler():
    """An hour before the nightly cutoff, remind customers about tomorrow; after it, generate
    tomorrow's routes once (and charge prepaid subs)."""
    while True:
        try:
            s = await get_settings()
            now = now_ist()
            cutoff = int(s["skip_cutoff_hour"])
            if now.hour == cutoff - 1:  # an hour before the cutoff: "skip tomorrow?" reminders
                res = await send_reminders_once(now.date() + timedelta(days=1), cutoff)
                if res:
                    log.info("Skip reminders for %s: %s", res["date"], res)
            if now.hour >= cutoff:
                target = (now.date() + timedelta(days=1)).isoformat()
                res = await generate_once(now.date() + timedelta(days=1), "scheduler")
                if res:
                    log.info("Generated routes for %s: %s", target, res)
        except Exception:
            log.exception("Route scheduler failed")
        await asyncio.sleep(300)


async def keep_awake():
    """Free hosts like Render's put the server to sleep after ~15 minutes without visitors, so the next
    visitor waits up to a minute. Visiting our own public address every few minutes keeps it awake."""
    url = f"{config.KEEP_AWAKE_URL}/api/health"
    log.info("Keep-awake: visiting %s every %s minutes", url, config.KEEP_AWAKE_MINUTES)
    while True:
        await asyncio.sleep(config.KEEP_AWAKE_MINUTES * 60)
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                await client.get(url)
        except httpx.HTTPError as e:
            log.warning("Keep-awake visit failed: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    config.check_production_safety()
    connect()
    if config.MONGO_URL.startswith("mongomock://"):
        log.warning("Using the in-memory test database: all data is lost when the server restarts or sleeps. "
                    "Set MONGO_URL (e.g. a free MongoDB Atlas cluster) to keep data.")
    await ensure_indexes()
    await seed(demo_accounts=False, db=real_db())  # demo accounts only ever exist in demo mode's copy
    await remove_demo_accounts()
    saved = await real_db().settings.find_one({"key": "global"}, {"demo_mode": 1})
    on = bool(saved["demo_mode"]) if saved and "demo_mode" in saved else config.DEMO_MODE  # Admin's choice wins
    await set_demo_mode(on, save=False)
    tasks = [asyncio.create_task(route_scheduler())]
    if config.KEEP_AWAKE and config.KEEP_AWAKE_URL:
        tasks.append(asyncio.create_task(keep_awake()))
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="MooNest API", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=config.CORS_ORIGINS, allow_credentials=False,
                   allow_methods=["*"], allow_headers=["*"])
for r in (auth, catalog, customer, subscriptions, agent, admin, push, ws):
    app.include_router(r.router)

config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/api/uploads", StaticFiles(directory=config.UPLOAD_DIR), name="uploads")


@app.get("/api/health")
async def health():
    return {"ok": True, "time": now_iso()}


# Single-server deployment: serve the built app (index.html + img/) after all /api routes.
if config.FRONTEND_DIST:
    app.mount("/", StaticFiles(directory=config.FRONTEND_DIST, html=True), name="app")
