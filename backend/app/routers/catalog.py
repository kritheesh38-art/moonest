from fastapi import APIRouter, Depends, HTTPException

from .. import config
from ..db import get_db
from ..security import current_user
from ..services import geocode, payments, places
from ..services.core import get_settings, serviceable
from ..utils import clean, next_cycle_date, now_ist

router = APIRouter(prefix="/api", tags=["catalog"])


@router.get("/config")
async def public_config():
    s = await get_settings()
    cutoff = int(s["skip_cutoff_hour"])
    return {
        "city": s["city"], "slots": s["slots"], "skip_cutoff_hour": cutoff,
        "max_pause_days": s["max_pause_days"], "delivery_fee_paise": s["delivery_fee_paise"],
        "free_delivery_above_paise": s["free_delivery_above_paise"],
        "next_cycle_date": next_cycle_date(cutoff).isoformat(), "server_time": now_ist().isoformat(),
        "payments_mode": payments.mode(), "razorpay_key_id": config.RAZORPAY_KEY_ID or None,
        "demo_mode": config.DEMO_MODE, "location_interval_seconds": config.LOCATION_INTERVAL_SECONDS,
        "data_mode": "server", "otp_available": config.DEMO_MODE or config.twilio_enabled(),
        "geocoding": bool(config.GEOCODER_URL), "place_search": config.place_search_provider() or None,
    }


@router.get("/products")
async def products():
    return [clean(p) async for p in get_db().products.find({"active": True}).sort("sort", 1)]


@router.get("/products/{product_id}")
async def product(product_id: str):
    p = clean(await get_db().products.find_one({"id": product_id, "active": True}))
    if not p:
        raise HTTPException(404, "Product not found")
    return p


@router.get("/plans")
async def plans():
    return [clean(p) async for p in get_db().plans.find({"active": True}).sort("sort", 1)]


@router.get("/serviceability/{pincode}")
async def check_serviceability(pincode: str):
    area = await serviceable(pincode)
    return {"pincode": pincode, "serviceable": bool(area), "area": area}


@router.get("/geocode/reverse")
async def reverse_geocode(lat: float, lng: float, user: dict = Depends(current_user)):
    """Street, area and pincode for a GPS position (fills the address form from "Use my current location")."""
    return await geocode.reverse(lat, lng)


@router.get("/geocode/search")
async def search_places(q: str, lat: float | None = None, lng: float | None = None, session: str = "",
                        user: dict = Depends(current_user)):
    """Address suggestions as the customer types, nearest to them (or to the delivery areas) first."""
    if lat is None or lng is None:
        area = await get_db().areas.find_one({"active": True}, sort=[("pincode", 1)])
        if area:
            lat, lng = area["lat"], area["lng"]
    return await places.suggest(q, lat, lng, session[:64])


@router.get("/geocode/place")
async def place_details(id: str, session: str = "", user: dict = Depends(current_user)):
    """Exact position and address fields of a suggestion the customer picked."""
    return await places.details(id[:300], session[:64])


@router.get("/areas")
async def areas():
    return [clean(a) async for a in get_db().areas.find({"active": True})]
