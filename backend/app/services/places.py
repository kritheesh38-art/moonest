"""Address search as you type ("Search your apartment, street or area") and the chosen place's details.

One provider, picked by config.place_search_provider(): Google Places (New), Ola Maps, or the free
OpenStreetMap search from Photon. Each returns the same shapes:
  suggestions: [{id, title, subtitle}]            (id is "<provider>:<their id>")
  place:       {lat, lng, line1, line2, landmark, city, pincode, display_name}
"""
import json
import logging
import time

import httpx
from fastapi import HTTPException

from .. import config
from .geocode import USER_AGENT, _join, _pincode

log = logging.getLogger("moonest.places")
GOOGLE = "https://places.googleapis.com/v1"
OLA = "https://api.olamaps.io/places/v1"
_cache: dict[tuple, tuple[float, object]] = {}
CACHE_SECONDS = 600


def _cached(key: tuple):
    hit = _cache.get(key)
    return hit[1] if hit and time.monotonic() - hit[0] < CACHE_SECONDS else None


def _keep(key: tuple, value):
    if len(_cache) > 2000:
        _cache.clear()
    _cache[key] = (time.monotonic(), value)
    return value


async def _get(url: str, **kw) -> dict:
    async with httpx.AsyncClient(timeout=6, headers={"User-Agent": USER_AGENT, **kw.pop("headers", {})}) as client:
        r = await client.request(kw.pop("method", "GET"), url, **kw)
    r.raise_for_status()
    return r.json()


# ---------------- Google Places (New) ----------------
def _google_place(p: dict) -> dict:
    parts: dict[str, str] = {}
    for c in p.get("addressComponents") or []:
        for t in c.get("types") or []:
            parts.setdefault(t, c.get("longText") or "")
    name = (p.get("displayName") or {}).get("text", "")
    road = parts.get("route", "")
    area = parts.get("sublocality_level_1") or parts.get("sublocality") or parts.get("neighborhood", "")
    city = parts.get("locality") or parts.get("administrative_area_level_3", "")
    building = name if name and name not in (road, area, city) else ""
    loc = p.get("location") or {}
    return {
        "lat": loc.get("latitude"), "lng": loc.get("longitude"),
        "line1": _join(parts.get("subpremise", ""), parts.get("street_number", ""), parts.get("premise", ""), building),
        "line2": _join(road, parts.get("sublocality_level_2", ""), area, city),
        "landmark": "", "city": city, "pincode": _pincode(parts.get("postal_code")),
        "display_name": p.get("formattedAddress", ""),
    }


async def _google_suggest(q: str, lat: float, lng: float, session: str) -> list[dict]:
    body = {"input": q, "includedRegionCodes": ["in"], "languageCode": "en",
            "locationBias": {"circle": {"center": {"latitude": lat, "longitude": lng}, "radius": 30000.0}}}
    if session:
        body["sessionToken"] = session
    data = await _get(f"{GOOGLE}/places:autocomplete", method="POST", content=json.dumps(body),
                      headers={"X-Goog-Api-Key": config.GOOGLE_MAPS_API_KEY, "Content-Type": "application/json"})
    out = []
    for s in data.get("suggestions") or []:
        p = s.get("placePrediction")
        if not p:
            continue
        fmt = p.get("structuredFormat") or {}
        out.append({"id": f"google:{p['placeId']}", "title": (fmt.get("mainText") or {}).get("text") or p["text"]["text"],
                    "subtitle": (fmt.get("secondaryText") or {}).get("text", "")})
    return out


async def _google_details(pid: str, session: str) -> dict:
    data = await _get(f"{GOOGLE}/places/{pid}", params={"sessionToken": session} if session else None,
                      headers={"X-Goog-Api-Key": config.GOOGLE_MAPS_API_KEY,
                               "X-Goog-FieldMask": "location,addressComponents,formattedAddress,displayName"})
    return _google_place(data)


# ---------------- Ola Maps ----------------
def _ola_place(r: dict) -> dict:
    parts: dict[str, str] = {}
    for c in r.get("address_components") or []:
        for t in c.get("types") or []:
            parts.setdefault(t, c.get("long_name") or "")
    loc = (r.get("geometry") or {}).get("location") or {}
    road = parts.get("route", "")
    area = parts.get("sublocality") or parts.get("sublocality_level_1") or parts.get("neighborhood", "")
    city = parts.get("locality") or parts.get("administrative_area_level_3", "")
    name = r.get("name", "")
    return {
        "lat": loc.get("lat"), "lng": loc.get("lng"),
        "line1": _join(parts.get("street_number", ""), parts.get("premise", ""),
                       name if name and name not in (road, area, city) else ""),
        "line2": _join(road, area, city), "landmark": "", "city": city,
        "pincode": _pincode(parts.get("postal_code")), "display_name": r.get("formatted_address", ""),
    }


async def _ola_suggest(q: str, lat: float, lng: float, session: str) -> list[dict]:
    data = await _get(f"{OLA}/autocomplete", params={"input": q, "location": f"{lat},{lng}", "api_key": config.OLA_MAPS_API_KEY},
                      headers={"X-Request-Id": session or "moonest"})
    out = []
    for p in data.get("predictions") or []:
        fmt = p.get("structured_formatting") or {}
        out.append({"id": f"ola:{p['place_id']}", "title": fmt.get("main_text") or p.get("description", ""),
                    "subtitle": fmt.get("secondary_text", "")})
    return out


async def _ola_details(pid: str, session: str) -> dict:
    data = await _get(f"{OLA}/details", params={"place_id": pid, "api_key": config.OLA_MAPS_API_KEY},
                      headers={"X-Request-Id": session or "moonest"})
    return _ola_place(data.get("result") or {})


# ---------------- OpenStreetMap (Photon), free ----------------
def _photon_place(f: dict) -> dict:
    p = f.get("properties") or {}
    lng, lat = (f.get("geometry") or {}).get("coordinates", [None, None])[:2]
    city = p.get("city") or p.get("county") or ""
    area = p.get("district") or p.get("locality") or ""
    is_place = p.get("type") in ("house", "street", "district", "locality", "city")
    name = p.get("name", "")
    return {
        "lat": lat, "lng": lng,
        "line1": _join(p.get("housenumber", ""), name if p.get("type") == "house" else ""),
        "line2": _join(p.get("street", "") or (name if p.get("type") == "street" else ""), area, city),
        "landmark": name if name and not is_place else "", "city": city, "pincode": _pincode(p.get("postcode")),
        "display_name": _join(name, p.get("street", ""), area, city, p.get("state", "")),
    }


async def _osm_search(q: str, lat: float, lng: float) -> list[dict]:
    url = config.PHOTON_URL.replace("/reverse", "/api")
    data = await _get(url, params={"q": q, "lat": lat, "lon": lng, "limit": 8, "lang": "en"})
    return [f for f in data.get("features") or [] if (f.get("properties") or {}).get("countrycode") == "IN"][:6]


async def _osm_suggest(q: str, lat: float, lng: float, session: str) -> list[dict]:
    out = []
    for f in await _osm_search(q, lat, lng):
        p = f.get("properties") or {}
        place = _photon_place(f)
        if place["lat"] is None:
            continue
        pid = f"osm:{p.get('osm_type', '')}{p.get('osm_id', '')}"
        _keep(("place", pid), place)  # Photon already gave everything; no second call needed
        out.append({"id": pid, "title": p.get("name") or _join(p.get("housenumber", ""), p.get("street", "")),
                    "subtitle": _join(p.get("street", "") if p.get("name") else "", p.get("district", ""), p.get("city", ""),
                                      p.get("postcode", ""))})
    return out


PROVIDERS = {"google": (_google_suggest, _google_details), "ola": (_ola_suggest, _ola_details),
             "osm": (_osm_suggest, None)}


async def suggest(q: str, lat: float | None, lng: float | None, session: str = "") -> list[dict]:
    q = " ".join(q.split())[:120]
    provider = config.place_search_provider()
    if not provider:
        raise HTTPException(503, "Address search is off. Type your address instead.")
    if len(q) < 3:
        return []
    lat, lng = (lat, lng) if lat is not None and lng is not None else (config.DEPOT_LAT, config.DEPOT_LNG)
    key = ("suggest", provider, q.lower(), round(lat, 2), round(lng, 2))
    if (hit := _cached(key)) is not None:
        return hit
    try:
        found = await PROVIDERS[provider][0](q, lat, lng, session)
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
        log.warning("Address search via %s failed: %s", provider, e)
        raise HTTPException(502, "Address search isn't answering right now. Type your address instead.")
    return _keep(key, found)


async def details(place_id: str, session: str = "") -> dict:
    if (hit := _cached(("place", place_id))) is not None:
        return hit
    provider, _, pid = place_id.partition(":")
    fetch = PROVIDERS.get(provider, (None, None))[1]
    if not fetch or not pid or provider != config.place_search_provider():
        raise HTTPException(404, "Search again and pick the place from the list")
    try:
        place = await fetch(pid, session)
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as e:
        log.warning("Place details via %s failed: %s", provider, e)
        raise HTTPException(502, "Couldn't load that place. Try again or type your address.")
    if place.get("lat") is None:
        raise HTTPException(502, "That place has no map position. Pick another or type your address.")
    return _keep(("place", place_id), place)
