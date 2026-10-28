"""Password accounts, the shared catalogue, the demo route helper, delivery and invoices."""
import json
import os
from pathlib import Path

os.environ["MONGO_URL"] = "mongomock://"
os.environ["DEMO_MODE"] = "true"
os.environ["JWT_SECRET"] = "test-secret-that-is-long-enough-for-hs256"

import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app
from app.seed import CATALOGUE_FILE
from tests.conftest import ADMIN_PASSWORD

FRONTEND_CATALOGUE = Path(__file__).resolve().parents[2] / "frontend" / "src" / "server" / "catalogue.json"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def bearer(r):
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def sign_in(c, identifier, role="customer", password="pass1234"):
    return bearer(c.post("/api/auth/login", json={"identifier": identifier, "password": password, "role": role}))


# ---------------- catalogue ----------------
@pytest.mark.skipif(not FRONTEND_CATALOGUE.exists(), reason="frontend not checked out next to the backend")
def test_catalogue_matches_frontend():
    assert json.loads(CATALOGUE_FILE.read_text()) == json.loads(FRONTEND_CATALOGUE.read_text())


def test_catalogue_seeded_with_packet_colours(client):
    products = client.get("/api/products").json()
    ids = [p["id"] for p in products]
    assert ids == [p["id"] for p in json.loads(CATALOGUE_FILE.read_text())]
    aavin = [p for p in products if p.get("group") == "aavin-milk"]
    assert {p["pack_label"]: p["price_paise"] for p in aavin} == {"Blue": 2000, "Green": 2200, "Violet": 2200,
                                                                  "Orange": 3000}
    assert all(p["image"].startswith("img/") for p in products)
    dairy = [p for p in products if p["category"] == "dairy"]
    assert {p["brand"] for p in dairy} == {"Aavin", "Amul", "Heritage"}
    assert not next(p for p in dairy if p["id"] == "amul-ghee")["subscribable"]


def test_seed_is_idempotent_and_keeps_admin_edits(client):
    from app.seed import seed

    ah = sign_in(client, "ritissh", "admin", password=ADMIN_PASSWORD)
    client.put("/api/admin/products/heritage-milk-green", headers=ah, json={"price_paise": 2800})
    client.portal.call(seed)  # what every restart does
    products = client.get("/api/products").json()
    assert len(products) == len({p["id"] for p in products}) == 20
    assert next(p for p in products if p["id"] == "heritage-milk-green")["price_paise"] == 2800
    client.put("/api/admin/products/heritage-milk-green", headers=ah, json={"price_paise": 2700})


# ---------------- accounts ----------------
def test_demo_accounts_sign_in(client):
    me = client.get("/api/auth/me", headers=sign_in(client, "customer@moonest.in")).json()
    assert me["name"] == "Aditi Rao" and me["wallet_paise"] == 50000 and "password_hash" not in me
    assert client.get("/api/auth/me", headers=sign_in(client, "9000000001", "agent")).json()["name"] == "Ravi Kumar"
    assert client.get("/api/admin/overview", headers=sign_in(client, "ritissh", "admin", password=ADMIN_PASSWORD)).status_code == 200


def test_register_and_login(client):
    body = {"name": "Kritheesh K", "email": "Krit@Example.com", "phone": "+91 99887-76655", "password": "longpass1"}
    r = client.post("/api/auth/register", json=body)
    assert r.status_code == 200, r.text
    u = r.json()["user"]
    assert u["email"] == "krit@example.com" and u["phone"] == "9988776655" and u["role"] == "customer"
    assert client.post("/api/auth/register", json=body).status_code == 409
    assert client.post("/api/auth/register", json={**body, "email": "other@example.com"}).status_code == 409
    assert client.post("/api/auth/register", json={**body, "email": "x@y.in", "phone": "9988770000",
                                                   "password": "short"}).status_code == 422
    sign_in(client, "krit@example.com", password="longpass1")
    sign_in(client, "9988776655", password="longpass1")
    r = client.post("/api/auth/login", json={"identifier": "krit@example.com", "password": "longpass1", "role": "agent"})
    assert r.status_code == 403


def test_wrong_password_locks_after_five_attempts(client):
    client.post("/api/auth/register", json={"name": "Lock Test", "email": "lock@example.com", "phone": "9123456780",
                                            "password": "rightpass1"})
    for _ in range(5):
        r = client.post("/api/auth/login", json={"identifier": "lock@example.com", "password": "nope"})
        assert r.status_code == 400 and r.json()["detail"] == "Email or password is incorrect"
    r = client.post("/api/auth/login", json={"identifier": "lock@example.com", "password": "rightpass1"})
    assert r.status_code == 429


def test_agent_self_signup_only_in_demo_mode(client, monkeypatch):
    body = {"name": "New Agent", "email": "agent2@example.com", "phone": "9000011111", "password": "longpass1",
            "role": "agent"}
    monkeypatch.setattr(config, "DEMO_MODE", False)
    assert client.post("/api/auth/register", json=body).status_code == 403
    monkeypatch.setattr(config, "DEMO_MODE", True)
    assert client.post("/api/auth/register", json=body).json()["user"]["role"] == "agent"


def test_production_needs_real_secret(monkeypatch):
    monkeypatch.setattr(config, "DEMO_ENV", False)
    monkeypatch.setattr(config, "JWT_SECRET", "change-me-in-production")
    with pytest.raises(RuntimeError):
        config.check_production_safety()
    monkeypatch.setattr(config, "JWT_SECRET", "x" * 40)
    config.check_production_safety()


# ---------------- demo route, delivery, invoices ----------------
def test_run_tomorrow_today_then_deliver(client):
    h = sign_in(client, "customer@moonest.in")
    addr = client.post("/api/addresses", headers=h, json={"line1": "12, 5th Cross", "pincode": "560034"}).json()
    assert addr["approx_location"] and abs(addr["lat"] - 12.9352) < 0.01
    nxt = client.get("/api/config").json()["next_cycle_date"]
    r = client.post("/api/orders", headers=h, json={"items": [{"product_id": "aavin-milk-blue", "qty": 2},
                                                              {"product_id": "amul-butter", "qty": 1}],
                                                    "address_id": addr["id"], "slot": "morning",
                                                    "delivery_date": nxt, "payment_method": "cod"})
    order = r.json()["order"]
    assert [i["name"] for i in order["items"]] == ["Aavin Nice Toned Milk (Blue packet)", "Amul Pasteurised Butter"]
    sub = client.post("/api/subscriptions", headers=h, json={
        "product_id": "aavin-curd", "quantity": 1, "plan_code": "daily", "slot": "morning", "start_date": nxt,
        "address_id": addr["id"], "payment_method": "wallet"}).json()["subscription"]

    ah = sign_in(client, "ritissh", "admin", password=ADMIN_PASSWORD)
    first = client.post("/api/admin/demo/run-tomorrow-today", headers=ah).json()
    assert first["created"] == 2
    assert client.post("/api/admin/demo/run-tomorrow-today", headers=ah).json()["created"] == 0
    wallet_after_first = client.get("/api/wallet", headers=h).json()["balance_paise"]
    assert wallet_after_first == 50000 - sub["per_delivery_paise"]
    # the nightly run for that day must not create the same stops or charge again
    assert client.post("/api/admin/routes/generate", headers=ah, json={"date": nxt}).json()["created"] == 0
    assert client.get("/api/wallet", headers=h).json()["balance_paise"] == wallet_after_first

    gh = sign_in(client, "agent@moonest.in", "agent")
    stops = client.get("/api/agent/today", headers=gh).json()["stops"]
    stop = next(s for s in stops if s["kind"] == "order")
    client.post("/api/agent/trips/start", headers=gh, json={"slot": "morning"})
    assert client.get("/api/notifications", headers=gh).status_code == 200  # agents read notifications too
    track = client.get("/api/tracking/today", headers=h).json()
    assert track and track[0]["trip_status"] == "active"
    r = client.post(f"/api/agent/deliveries/{stop['id']}/delivered", headers=gh)  # no photo needed
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "delivered" and not r.json().get("photo_url")
    assert client.post(f"/api/agent/deliveries/{stop['id']}/delivered", headers=gh).status_code == 400  # only once
    assert client.get(f"/api/orders/{order['id']}", headers=h).json()["delivery"]["status"] == "delivered"

    month = stop["date"][:7]
    invs = client.get("/api/invoices", headers=h).json()
    assert invs[0]["id"] == month and invs[0]["amount_paise"] == order["total_paise"]
    inv = client.get(f"/api/invoices/{month}", headers=h).json()
    assert inv["total_paise"] == order["total_paise"] and inv["lines"][0]["name"].startswith("Aavin")
    html = client.get(f"/api/invoices/{month}?format=html", headers=h)
    assert html.headers["content-type"].startswith("text/html") and "Aavin Nice Toned Milk" in html.text


def test_admin_creates_dairy_product(client):
    ah = sign_in(client, "ritissh", "admin", password=ADMIN_PASSWORD)
    r = client.post("/api/admin/products", headers=ah, json={"name": "Lassi", "brand": "Aavin", "unit": "200 ml",
                                                              "category": "dairy", "price_paise": 2500})
    assert r.status_code == 201 and r.json()["subscribable"] is False
    assert client.post("/api/admin/products", headers=ah, json={"name": "X", "unit": "1", "price_paise": 50,
                                                                 "category": "milk"}).status_code == 422


def test_only_configured_admins(client):
    for name in ("ritissh", "KRITHEESH"):
        me = client.get("/api/auth/me", headers=sign_in(client, name, "admin", password=ADMIN_PASSWORD)).json()
        assert me["role"] == "admin" and me["username"] == name.lower() and "password_hash" not in me
    # the old demo admin and every other account are not admins
    assert client.post("/api/auth/login", json={"identifier": "admin@moonest.in", "password": "pass1234",
                                                "role": "admin"}).status_code == 400
    assert client.post("/api/auth/login", json={"identifier": "customer@moonest.in", "password": "pass1234",
                                                "role": "admin"}).status_code == 403
    # no OTP route into admin, even in demo mode
    assert client.post("/api/auth/request-otp", json={"phone": "9000000000", "role": "admin"}).status_code == 403
    assert client.post("/api/auth/verify-otp", json={"phone": "9000000000", "role": "admin",
                                                     "code": "000000"}).status_code == 403
    # sign-up can't create admins
    r = client.post("/api/auth/register", json={"name": "Sneaky", "email": "s@x.in", "phone": "9123400001",
                                                "password": "longpass1", "role": "admin"})
    assert r.status_code == 422
    customer = sign_in(client, "customer@moonest.in")
    assert client.get("/api/admin/overview", headers=customer).status_code == 403


def test_admin_access_is_reapplied_on_start(client, monkeypatch):
    from app.db import get_db
    from app.seed import bootstrap_admin

    client.portal.call(lambda: get_db().users.update_one({"email": "customer@moonest.in"}, {"$push": {"roles": "admin"}}))
    monkeypatch.setattr(config, "ADMIN_PASSWORD", "rotated-pw")
    client.portal.call(bootstrap_admin)  # what every restart does
    assert client.post("/api/auth/login", json={"identifier": "customer@moonest.in", "password": "pass1234",
                                                "role": "admin"}).status_code == 403
    assert client.post("/api/auth/login", json={"identifier": "ritissh", "password": ADMIN_PASSWORD,
                                                "role": "admin"}).status_code == 400
    sign_in(client, "ritissh", "admin", password="rotated-pw")


def test_demo_mode_accepts_any_pincode_and_routes_it(client, monkeypatch):
    h = sign_in(client, "customer@moonest.in")
    assert client.get("/api/serviceability/600040").json()["area"]["name"] == "Pincode 600040 (test mode)"
    assert not client.get("/api/serviceability/012345").json()["serviceable"]  # not a valid pincode
    addr = client.post("/api/addresses", headers=h, json={"line1": "7 Anna Nagar 2nd Ave", "pincode": "600040"})
    assert addr.status_code == 201, addr.text
    nxt = client.get("/api/config").json()["next_cycle_date"]
    r = client.post("/api/orders", headers=h, json={"items": [{"product_id": "aavin-milk-green", "qty": 1}],
                                                    "address_id": addr.json()["id"], "slot": "evening",
                                                    "delivery_date": nxt, "payment_method": "cod"})
    assert r.status_code == 201, r.text
    from app.seed import bootstrap_admin

    client.portal.call(bootstrap_admin)  # an earlier test rotated the password; a restart re-applies it
    ah = sign_in(client, "ritissh", "admin", password=ADMIN_PASSWORD)
    client.post("/api/admin/demo/run-tomorrow-today", headers=ah)
    stops = client.get("/api/agent/today", headers=sign_in(client, "agent@moonest.in", "agent")).json()["stops"]
    assert any(s["address"]["pincode"] == "600040" for s in stops)  # the demo agent gets test-area stops
    # an area switched off in Admin is never served, even in demo mode
    client.post("/api/admin/areas/560038/toggle", headers=ah)
    assert not client.get("/api/serviceability/560038").json()["serviceable"]
    # production: unknown pincodes are not served
    monkeypatch.setattr(config, "DEMO_MODE", False)
    assert not client.get("/api/serviceability/600040").json()["serviceable"]


def test_admin_switches_demo_mode(client, monkeypatch):
    from app.db import get_db
    from app.seed import bootstrap_admin

    client.portal.call(bootstrap_admin)
    ah = sign_in(client, "ritissh", "admin", password=ADMIN_PASSWORD)
    customer = sign_in(client, "customer@moonest.in")
    assert client.get("/api/admin/settings", headers=ah).json()["demo_mode"] is True
    assert client.get("/api/config").json()["otp_available"] is True

    try:
        off = client.put("/api/admin/settings", headers=ah, json={"demo_mode": False})
        assert off.json()["demo_mode"] is False
        cfg = client.get("/api/config").json()
        assert cfg["demo_mode"] is False and cfg["payments_mode"] == "disabled" and cfg["otp_available"] is False
        # demo accounts are locked out, including sessions already signed in
        assert client.get("/api/auth/me", headers=customer).status_code == 401
        r = client.post("/api/auth/login", json={"identifier": "customer@moonest.in", "password": "pass1234"})
        assert r.status_code in (400, 401, 403)  # demo accounts only exist in demo mode's copy
        assert client.post("/api/auth/request-otp", json={"phone": "9811122233"}).json().get("dev_otp") is None
        # test areas and the demo route helper are off; admin still works
        assert not client.get("/api/serviceability/600040").json()["serviceable"]
        assert client.post("/api/admin/demo/run-tomorrow-today", headers=ah).status_code == 403
        # the choice is saved, so a restart keeps it
        assert client.portal.call(lambda: get_db().settings.find_one({"key": "global"}))["demo_mode"] is False

    finally:
        client.put("/api/admin/settings", headers=ah, json={"demo_mode": True})
    customer = sign_in(client, "customer@moonest.in")
    assert client.get("/api/auth/me", headers=customer).status_code == 200
    assert client.get("/api/admin/settings", headers=customer).status_code == 403  # customers can't switch it


def test_demo_mode_data_is_never_saved(client):
    """Everything done in demo mode happens on a throwaway copy; the real data stays as it was."""
    from app.db import real_db

    ah = sign_in(client, "ritissh", "admin", password=ADMIN_PASSWORD)
    find = lambda q: client.portal.call(lambda: real_db().users.find_one(q))  # noqa: E731
    client.put("/api/admin/settings", headers=ah, json={"demo_mode": False})
    try:
        real = client.post("/api/auth/register", json={"name": "Kept", "email": "kept@x.in", "phone": "9123400031",
                                                       "password": "longpass1"})
        assert real.status_code == 200, real.text
        client.put("/api/admin/settings", headers=ah, json={"demo_mode": True})
        assert client.get("/api/admin/settings", headers=ah).json()["storage"] == "demo"
        # real accounts still work in demo mode, but nothing done there is saved
        kept = client.post("/api/auth/login", json={"identifier": "kept@x.in", "password": "longpass1"})
        assert kept.status_code == 200
        r = client.post("/api/auth/register", json={"name": "Tester", "email": "tester@x.in", "phone": "9123400032",
                                                    "password": "longpass1"})
        assert r.status_code == 200 and find({"email": "tester@x.in"}) is None
        client.put("/api/admin/settings", headers=ah, json={"city": "Demo City"})
        assert find({"id": "u-demo-customer"}) is None  # demo accounts never reach the real data
        client.put("/api/admin/settings", headers=ah, json={"demo_mode": False})
        assert client.post("/api/auth/login", json={"identifier": "tester@x.in", "password": "longpass1"}).status_code in (400, 401)
        assert client.get("/api/config").json()["city"] != "Demo City"
        assert find({"email": "kept@x.in"}) is not None
    finally:
        client.put("/api/admin/settings", headers=ah, json={"demo_mode": True})


def test_reverse_geocode(client, monkeypatch):
    from app.services import geocode

    async def nominatim(lat, lng):
        return {"line1": "", "line2": "2nd Avenue, Anna Nagar, Chennai", "landmark": "", "city": "Chennai",
                "pincode": "", "display_name": "Anna Nagar, Chennai"}

    async def photon(lat, lng):  # the second service fills the pincode Nominatim lacked
        return {"line1": "12", "line2": "2nd Ave", "landmark": "", "city": "Chennai", "pincode": "600040",
                "display_name": ""}

    monkeypatch.setattr(geocode, "_nominatim", nominatim)
    monkeypatch.setattr(geocode, "_photon", photon)
    geocode._cache.clear()
    assert client.get("/api/geocode/reverse?lat=13.08&lng=80.21").status_code == 401  # signed-in only
    h = sign_in(client, "customer@moonest.in")
    r = client.get("/api/geocode/reverse?lat=13.0850&lng=80.2101", headers=h).json()
    assert r["line2"] == "2nd Avenue, Anna Nagar, Chennai" and r["pincode"] == "600040" and r["line1"] == "12"

    async def down(lat, lng):
        raise geocode.httpx.ConnectError("no network")

    monkeypatch.setattr(geocode, "_nominatim", down)
    assert client.get("/api/geocode/reverse?lat=11.0&lng=77.0", headers=h).json()["pincode"] == "600040"  # Photon alone
    monkeypatch.setattr(geocode, "_photon", down)
    assert client.get("/api/geocode/reverse?lat=11.5&lng=77.5", headers=h).status_code == 502


def test_geocode_parsers(monkeypatch):
    import asyncio

    from app.services import geocode

    class Resp:
        def __init__(self, data): self.data = data
        def raise_for_status(self): pass
        def json(self): return self.data

    class Client:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): pass
        async def get(self, url, params=None):
            if "photon" in url:
                return Resp({"features": [{"properties": {"housenumber": "7", "street": "2nd Avenue",
                                                          "district": "Anna Nagar", "city": "Chennai",
                                                          "postcode": "600 040", "type": "house"}}]})
            return Resp({"display_name": "x", "address": {"house_number": "7", "road": "2nd Avenue",
                                                          "suburb": "Anna Nagar", "city": "Chennai",
                                                          "postcode": "600040", "amenity": "Tower Park"}})

    monkeypatch.setattr(geocode.httpx, "AsyncClient", Client)
    n = asyncio.run(geocode._nominatim(13.08, 80.21))
    p = asyncio.run(geocode._photon(13.08, 80.21))
    assert n["line1"] == "7" and n["line2"] == "2nd Avenue, Anna Nagar, Chennai" and n["pincode"] == "600040"
    assert n["landmark"] == "Tower Park"
    assert p["line1"] == "7" and p["line2"] == "2nd Avenue, Anna Nagar, Chennai" and p["pincode"] == "600040"

def test_default_admins_include_subhasree(monkeypatch):
    import importlib

    monkeypatch.delenv("ADMIN_USERS", raising=False)
    fresh = importlib.reload(config)
    try:
        assert fresh.ADMIN_USERS == ["ritissh", "kritheesh", "subhasree"]
    finally:
        monkeypatch.setenv("ADMIN_USERS", "ritissh, Kritheesh")
        importlib.reload(config)


def test_address_search_suggestions_and_place(client, monkeypatch):
    from app import config as cfg
    from app.services import places

    h = sign_in(client, "customer@moonest.in")
    monkeypatch.setattr(cfg, "GOOGLE_MAPS_API_KEY", "test-key")
    assert client.get("/api/config").json()["place_search"] == "google"
    seen = {}

    async def fake_get(url, **kw):
        seen.setdefault("urls", []).append(url)
        if url.endswith("places:autocomplete"):
            seen["body"] = json.loads(kw["content"])
            return {"suggestions": [{"placePrediction": {"placeId": "abc", "text": {"text": "Prestige Shantiniketan, Whitefield"},
                                                         "structuredFormat": {"mainText": {"text": "Prestige Shantiniketan"},
                                                                              "secondaryText": {"text": "Whitefield, Bengaluru"}}}}]}
        assert "displayName" not in kw["headers"]["X-Goog-FieldMask"]  # stays in the cheapest tier
        return {"location": {"latitude": 12.9897, "longitude": 77.7285}, "formattedAddress": "Prestige Shantiniketan, Whitefield",
                "addressComponents": [{"longText": "ITPL Main Road", "types": ["route"]},
                                      {"longText": "Whitefield", "types": ["sublocality_level_1", "sublocality"]},
                                      {"longText": "Bengaluru", "types": ["locality"]},
                                      {"longText": "560048", "types": ["postal_code"]}]}
    monkeypatch.setattr(places, "_get", fake_get)
    assert client.get("/api/geocode/search?q=pr", headers=h).json() == []  # too short: no call
    s = client.get("/api/geocode/search?q=Prestige%20Shanti&session=tok1", headers=h).json()
    assert s == [{"id": "google:abc", "title": "Prestige Shantiniketan", "subtitle": "Whitefield, Bengaluru"}]
    assert seen["body"]["includedRegionCodes"] == ["in"] and seen["body"]["sessionToken"] == "tok1"
    p = client.get("/api/geocode/place?id=google:abc&session=tok1&name=Prestige%20Shantiniketan", headers=h).json()
    assert p["lat"] == 12.9897 and p["pincode"] == "560048" and p["line1"] == "Prestige Shantiniketan"
    assert p["line2"] == "ITPL Main Road, Whitefield, Bengaluru"
    assert client.get("/api/geocode/search?q=abc").status_code == 401  # signed-in customers only
    assert client.get("/api/geocode/place?id=ola:zzz", headers=h).status_code == 404


def test_free_address_search_uses_openstreetmap(client, monkeypatch):
    from app import config as cfg
    from app.services import places

    monkeypatch.setattr(cfg, "GOOGLE_MAPS_API_KEY", "")
    monkeypatch.setattr(cfg, "OLA_MAPS_API_KEY", "")
    h = sign_in(client, "customer@moonest.in")

    async def fake_get(url, **kw):
        assert url.endswith("/api")
        return {"features": [
            {"geometry": {"coordinates": [80.2565, 13.0012]}, "properties": {
                "osm_type": "N", "osm_id": 7, "name": "Adyar Bakery", "street": "LB Road", "district": "Adyar",
                "city": "Chennai", "postcode": "600020", "countrycode": "IN", "type": "house"}},
            {"geometry": {"coordinates": [0, 0]}, "properties": {"name": "Elsewhere", "countrycode": "US"}}]}
    monkeypatch.setattr(places, "_get", fake_get)
    s = client.get("/api/geocode/search?q=adyar%20bakery", headers=h).json()
    assert len(s) == 1 and s[0]["id"] == "osm:N7" and "600020" in s[0]["subtitle"]
    p = client.get(f"/api/geocode/place?id={s[0]['id']}", headers=h).json()  # from the cache, no second call
    assert p["lat"] == 13.0012 and p["pincode"] == "600020" and "LB Road" in p["line2"]
