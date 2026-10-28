"""Reverse geocoding for "Use my current location": GPS position → house, street, area, pincode.

Tries OpenStreetMap Nominatim (GEOCODER_URL; at most ~1 request a second, identifying User-Agent),
then Photon (PHOTON_URL), both free and keyless. The app also looks the address up from the
customer's own browser when the server gets nothing, so a host whose IP a service blocks still works.
Set GEOCODER_URL to empty to turn server-side lookup off.
"""
import asyncio
import logging
import time

import httpx
from fastapi import HTTPException

from .. import config

log = logging.getLogger("moonest.geocode")
_cache: dict[tuple[float, float], dict] = {}
_lock = asyncio.Lock()
_last_call = 0.0
USER_AGENT = "MooNest/1.0 (milk delivery app; https://github.com/rkteam325-cell/MooNest)"


def _pincode(raw: str | None) -> str:
    digits = "".join(ch for ch in (raw or "") if ch.isdigit())
    return digits if len(digits) == 6 and digits[0] != "0" else ""


def _join(*parts: str) -> str:
    seen, out = set(), []
    for p in parts:
        if p and p.lower() not in seen:
            seen.add(p.lower())
            out.append(p)
    return ", ".join(out)


async def _nominatim(lat: float, lng: float) -> dict:
    global _last_call
    async with _lock:  # Nominatim's usage policy: no more than one request a second
        wait = 1.1 - (time.monotonic() - _last_call)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_call = time.monotonic()
        async with httpx.AsyncClient(timeout=8, headers={"User-Agent": USER_AGENT}) as client:
            r = await client.get(config.GEOCODER_URL, params={"format": "jsonv2", "lat": lat, "lon": lng,
                                                              "addressdetails": 1, "accept-language": "en"})
        r.raise_for_status()
        data = r.json()
    a = data.get("address") or {}
    road = a.get("road") or a.get("pedestrian") or a.get("residential") or ""
    area = a.get("suburb") or a.get("neighbourhood") or a.get("quarter") or a.get("city_district") or ""
    city = a.get("city") or a.get("town") or a.get("village") or a.get("county") or ""
    return {
        "line1": _join(a.get("house_number", ""), a.get("building", "")),
        "line2": _join(road, area, city),
        "landmark": a.get("amenity") or a.get("shop") or "",
        "city": city, "pincode": _pincode(a.get("postcode")),
        "display_name": data.get("display_name", ""),
    }


async def _photon(lat: float, lng: float) -> dict:
    async with httpx.AsyncClient(timeout=8, headers={"User-Agent": USER_AGENT}) as client:
        r = await client.get(config.PHOTON_URL, params={"lat": lat, "lon": lng, "lang": "en"})
    r.raise_for_status()
    feats = r.json().get("features") or []
    if not feats:
        return {}
    p = feats[0].get("properties") or {}
    city = p.get("city") or p.get("county") or ""
    area = p.get("district") or p.get("locality") or ""
    return {
        "line1": _join(p.get("housenumber", ""), p.get("name", "") if p.get("type") == "house" else ""),
        "line2": _join(p.get("street", ""), area, city),
        "landmark": p.get("name", "") if p.get("type") not in ("house", "street") else "",
        "city": city, "pincode": _pincode(p.get("postcode")),
        "display_name": _join(p.get("name", ""), p.get("street", ""), area, city, p.get("state", "")),
    }


async def pincode_centre(pincode: str) -> dict:
    """Map position of a pincode's centre, for a new delivery area added without coordinates."""
    tries = []
    if config.GEOCODER_URL:
        tries.append((config.GEOCODER_URL.replace("/reverse", "/search"),
                      {"postalcode": pincode, "country": "India", "format": "jsonv2", "limit": 1}))
    if config.PHOTON_URL:
        tries.append((config.PHOTON_URL.replace("/reverse", "/api"), {"q": f"{pincode} India", "limit": 1}))
    for url, params in tries:
        try:
            async with httpx.AsyncClient(timeout=8, headers={"User-Agent": USER_AGENT}) as client:
                r = await client.get(url, params=params)
            r.raise_for_status()
            data = r.json()
            if isinstance(data, list) and data:
                return {"lat": float(data[0]["lat"]), "lng": float(data[0]["lon"])}
            feats = data.get("features") if isinstance(data, dict) else None
            if feats:
                lng, lat = feats[0]["geometry"]["coordinates"][:2]
                return {"lat": float(lat), "lng": float(lng)}
        except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError) as e:
            log.warning("Pincode lookup via %s failed: %s", url, e)
    raise HTTPException(422, f"Couldn't find pincode {pincode} on the map. Enter its latitude and longitude.")


async def reverse(lat: float, lng: float) -> dict:
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        raise HTTPException(422, "Invalid location")
    if not config.GEOCODER_URL:
        raise HTTPException(503, "Address lookup is off. Type your address instead.")
    key = (round(lat, 4), round(lng, 4))  # ~10 m
    if key in _cache:
        return _cache[key]
    result: dict = {}
    for name, provider in (("nominatim", _nominatim), ("photon", _photon)):
        if name == "photon" and not config.PHOTON_URL:
            continue
        try:
            found = await provider(lat, lng)
        except (httpx.HTTPError, ValueError) as e:
            log.warning("Address lookup via %s failed: %s", name, e)
            continue
        # keep the first service's answers, fill gaps from the next (often the pincode)
        result = {**found, **{k: v for k, v in result.items() if v}}
        if result.get("line2") and result.get("pincode"):
            break
    if not (result.get("line2") or result.get("pincode")):
        raise HTTPException(502, "Couldn't look up your address. Your location is pinned; type the address in.")
    result = {"line1": "", "line2": "", "landmark": "", "city": "", "pincode": "", "display_name": "", **result}
    _cache[key] = result
    return result
