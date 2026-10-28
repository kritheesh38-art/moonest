"""Regression tests for issues found in the code review (agent takeover, route runs, money, dates)."""
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app import config, utils
from app.db import get_db
from app.main import app
from tests.conftest import ADMIN_PASSWORD


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def bearer(r):
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def login(c, identifier, role="customer", password="pass1234"):
    return bearer(c.post("/api/auth/login", json={"identifier": identifier, "password": password, "role": role}))


def register(c, name, email, phone):
    return bearer(c.post("/api/auth/register", json={"name": name, "email": email, "phone": phone,
                                                     "password": "longpass1"}))


def admin(c):
    return login(c, "ritissh", "admin", ADMIN_PASSWORD)


def nxt(c):
    return c.get("/api/config").json()["next_cycle_date"]


def address(c, h, pincode="560034", **extra):
    r = c.post("/api/addresses", headers=h, json={"line1": "12, 5th Cross", "pincode": pincode, **extra})
    assert r.status_code == 201, r.text
    return r.json()


def cod_order(c, h, addr, date, product="aavin-milk-blue"):
    r = c.post("/api/orders", headers=h, json={"items": [{"product_id": product, "qty": 1}], "address_id": addr["id"],
                                               "slot": "morning", "delivery_date": date, "payment_method": "cod"})
    assert r.status_code == 201, r.text
    return r.json()["order"]


def test_customer_cannot_take_over_an_agent_number(client):
    h = register(client, "Mallory", "mal@x.in", "9123400002")
    client.patch("/api/auth/me", headers=h, json={"phone": "9555512345"})
    r = client.post("/api/admin/agents", headers=admin(client), json={"name": "Real Agent", "phone": "9555512345",
                                                                      "pincodes": ["560034"]})
    assert r.status_code == 409
    assert client.post("/api/auth/login", json={"identifier": "mal@x.in", "password": "longpass1",
                                                "role": "agent"}).status_code == 403
    # a fresh number still onboards normally, and re-adding an existing agent just updates them
    ok = client.post("/api/admin/agents", headers=admin(client), json={"name": "Real Agent", "phone": "9555500000"})
    assert ok.status_code == 201 and ok.json()["roles"] == ["agent"]
    again = client.post("/api/admin/agents", headers=admin(client), json={"name": "x", "phone": "9555500000",
                                                                          "pincodes": ["560102"]})
    assert again.json()["pincodes"] == ["560102"]


def test_one_broken_subscription_does_not_stop_the_route(client):
    good = login(client, "customer@moonest.in")
    addr = address(client, good)
    sub = client.post("/api/subscriptions", headers=good, json={
        "product_id": "aavin-curd", "quantity": 1, "plan_code": "daily", "slot": "morning", "start_date": nxt(client),
        "address_id": addr["id"], "payment_method": "cod"}).json()["subscription"]
    # a subscription whose customer and address have no phone (this used to crash the whole run)
    day = nxt(client)
    client.portal.call(lambda: get_db().subscriptions.insert_one({
        "id": "sub-broken", "user_id": "nobody-phone", "product_id": "aavin-milk-blue", "quantity": 1,
        "plan_code": "daily", "custom_days": [], "slot": "morning", "start_date": day, "address_id": "addr-nophone",
        "payment_method": "wallet", "skips": [], "pauses": [], "status": "active", "created_at": "x"}))
    client.portal.call(lambda: get_db().users.insert_one({"id": "nobody-phone", "name": "No Phone", "roles": ["customer"]}))
    client.portal.call(lambda: get_db().addresses.insert_one({
        "id": "addr-nophone", "user_id": "nobody-phone", "label": "Home", "line1": "1 Road", "pincode": "560034",
        "area": "Koramangala", "lat": 12.93, "lng": 77.62}))
    r = client.post("/api/admin/routes/generate", headers=admin(client), json={"date": nxt(client)})
    assert r.status_code == 200, r.text
    stops = client.get(f"/api/admin/routes?date={nxt(client)}", headers=admin(client)).json()
    assert any(s["ref_id"] == sub["id"] for s in stops)
    client.post(f"/api/subscriptions/{sub['id']}/cancel", headers=good)


def test_change_address_needs_a_phone(client):
    h = bearer(client.post("/api/auth/verify-otp", json={
        "email": "nophone@x.in", "code": client.post("/api/auth/request-otp", json={"email": "nophone@x.in"}).json()["dev_otp"]}))
    a1 = address(client, h, contact_phone="9876500001")
    a2 = address(client, h)  # no contact phone, and the account has none
    sub = client.post("/api/subscriptions", headers=h, json={
        "product_id": "aavin-curd", "quantity": 1, "plan_code": "daily", "slot": "evening", "start_date": nxt(client),
        "address_id": a1["id"], "payment_method": "cod"}).json()["subscription"]
    assert client.post(f"/api/subscriptions/{sub['id']}/address", headers=h,
                       json={"address_id": a2["id"]}).status_code == 400


def test_failed_order_is_redelivered_once(client):
    h = register(client, "Redo", "redo@x.in", "9123400003")
    client.patch("/api/auth/me", headers=h, json={"missed_pref": "redeliver"})
    addr = address(client, h)
    order = cod_order(client, h, addr, nxt(client))
    client.post("/api/admin/demo/run-tomorrow-today", headers=admin(client))
    agent = login(client, "agent@moonest.in", "agent")
    stop = next(s for s in client.get("/api/agent/today", headers=agent).json()["stops"] if s["ref_id"] == order["id"])
    out = client.post(f"/api/agent/deliveries/{stop['id']}/failed", headers=agent, json={"reason": "gate_locked"}).json()
    new_date = out["missed_outcome"].split(":")[1]
    o = client.get(f"/api/orders/{order['id']}", headers=h).json()
    assert o["status"] == "confirmed" and o["delivery_date"] == new_date and "delivery_id" not in o
    client.post("/api/admin/routes/generate", headers=admin(client), json={"date": new_date})
    mine = [s for s in client.get(f"/api/admin/routes?date={new_date}", headers=admin(client)).json()
            if s["user_id"] == stop["user_id"]]
    assert len(mine) == 1 and mine[0]["kind"] == "order"


def test_payment_after_route_built_moves_to_next_open_day(client):
    h = register(client, "Late Payer", "late@x.in", "9123400004")
    addr = address(client, h)
    day = nxt(client)
    r = client.post("/api/orders", headers=h, json={"items": [{"product_id": "aavin-milk-blue", "qty": 1}],
                                                    "address_id": addr["id"], "slot": "morning", "delivery_date": day,
                                                    "payment_method": "razorpay"}).json()
    client.post("/api/admin/routes/generate", headers=admin(client), json={"date": day})  # the night's run happens
    assert client.post("/api/payments/verify", headers=h, json={"payment_id": r["payment"]["payment_id"],
                                                                "demo_outcome": "success"}).json()["status"] == "paid"
    o = client.get(f"/api/orders/{r['order']['id']}", headers=h).json()
    assert o["status"] == "confirmed" and o["delivery_date"] > day and o["rescheduled"]
    # a second confirmation does nothing
    again = client.post("/api/payments/verify", headers=h, json={"payment_id": r["payment"]["payment_id"],
                                                                 "demo_outcome": "success"}).json()
    assert again == {"status": "paid", "already": True}


def test_paying_for_a_cancelled_order_refunds(client):
    h = register(client, "Changed Mind", "mind@x.in", "9123400005")
    addr = address(client, h)
    r = client.post("/api/orders", headers=h, json={"items": [{"product_id": "aavin-milk-blue", "qty": 2}],
                                                    "address_id": addr["id"], "slot": "evening",
                                                    "delivery_date": utils.parse_date(nxt(client)).isoformat(),
                                                    "payment_method": "razorpay"}).json()
    assert client.post(f"/api/orders/{r['order']['id']}/cancel", headers=h).json()["status"] == "cancelled"
    v = client.post("/api/payments/verify", headers=h, json={"payment_id": r["payment"]["payment_id"],
                                                             "demo_outcome": "success"}).json()
    assert v["refunded_to_wallet"] and client.get("/api/wallet", headers=h).json()["balance_paise"] == r["order"]["total_paise"]
    assert client.post(f"/api/orders/{r['order']['id']}/cancel", headers=h).status_code == 400  # no second refund


def test_skip_after_route_built_removes_stop_and_refunds(client):
    h = register(client, "Skipper", "skip@x.in", "9123400006")
    t = client.post("/api/wallet/topup", headers=h, json={"amount_paise": 20000}).json()
    client.post("/api/payments/verify", headers=h, json={"payment_id": t["payment_id"], "demo_outcome": "success"})
    addr = address(client, h)
    day = utils.parse_date(nxt(client)) + timedelta(days=2)
    sub = client.post("/api/subscriptions", headers=h, json={
        "product_id": "aavin-milk-blue", "quantity": 1, "plan_code": "daily", "slot": "morning",
        "start_date": day.isoformat(), "address_id": addr["id"], "payment_method": "wallet"}).json()["subscription"]
    client.post("/api/admin/routes/generate", headers=admin(client), json={"date": day.isoformat()})  # built early
    assert client.get("/api/wallet", headers=h).json()["balance_paise"] == 20000 - sub["per_delivery_paise"]
    client.post(f"/api/subscriptions/{sub['id']}/skip", headers=h, json={"date": day.isoformat()})
    assert client.get("/api/wallet", headers=h).json()["balance_paise"] == 20000
    stops = client.get(f"/api/admin/routes?date={day.isoformat()}", headers=admin(client)).json()
    assert not any(s["ref_id"] == sub["id"] for s in stops)


def test_switching_to_alternate_keeps_a_later_start(client):
    h = login(client, "customer@moonest.in")
    addr = address(client, h)
    later = (utils.parse_date(nxt(client)) + timedelta(days=20)).isoformat()
    sub = client.post("/api/subscriptions", headers=h, json={
        "product_id": "aavin-curd", "quantity": 1, "plan_code": "daily", "slot": "morning", "start_date": later,
        "address_id": addr["id"], "payment_method": "cod"}).json()["subscription"]
    s2 = client.patch(f"/api/subscriptions/{sub['id']}", headers=h, json={"plan_code": "alternate"}).json()
    assert s2["start_date"] == later


def test_admin_small_fixes(client):
    ah = admin(client)
    assert client.get("/api/admin/customers?q=%2B91", headers=ah).status_code == 200  # "+91" used to crash
    client.put("/api/admin/products/aavin-ghee", headers=ah, json={"mrp_paise": 39900})
    assert client.put("/api/admin/products/aavin-ghee", headers=ah, json={"mrp_paise": None}).json()["mrp_paise"] is None
    assert client.put("/api/admin/products/aavin-ghee", headers=ah, json={"price_paise": None}).status_code == 422
    assert client.get("/api/products").json()[0]["price_paise"]
    area = client.post("/api/admin/areas", headers=ah, json={"pincode": "600040", "name": "Anna Nagar",
                                                             "lat": 13.085, "lng": 80.21}).json()
    assert area["id"] == "600040"


def test_removed_admin_loses_access_even_without_password(client, monkeypatch):
    from app.seed import bootstrap_admin

    token = admin(client)
    monkeypatch.setattr(config, "ADMIN_USERS", ["kritheesh"])
    monkeypatch.setattr(config, "ADMIN_PASSWORD", "")
    client.portal.call(bootstrap_admin)
    assert client.get("/api/admin/overview", headers=token).status_code == 401
    monkeypatch.setattr(config, "ADMIN_USERS", ["ritissh", "kritheesh"])
    monkeypatch.setattr(config, "ADMIN_PASSWORD", ADMIN_PASSWORD)
    client.portal.call(bootstrap_admin)
    assert client.get("/api/admin/overview", headers=admin(client)).status_code == 200


def test_cash_capped_and_past_routes_refused(client):
    h = register(client, "Cash Payer", "cash@x.in", "9123400007")
    addr = address(client, h)
    order = cod_order(client, h, addr, nxt(client))
    client.post("/api/admin/demo/run-tomorrow-today", headers=admin(client))
    agent = login(client, "agent@moonest.in", "agent")
    stop = next(s for s in client.get("/api/agent/today", headers=agent).json()["stops"] if s["ref_id"] == order["id"])
    client.post("/api/agent/trips/start", headers=agent, json={"slot": "morning"})
    # typed more cash than owed at delivery: only what's owed is recorded
    client.post(f"/api/agent/deliveries/{stop['id']}/delivered", headers=agent,
                data={"cash_paise": str(order["total_paise"] + 5000)})
    assert client.get("/api/auth/me", headers=h).json()["cod_due_paise"] == 0
    r = client.post(f"/api/agent/deliveries/{stop['id']}/cash", headers=agent, json={"amount_paise": 100})
    assert r.status_code == 400 and r.json()["detail"] == "Nothing is due from this customer"
    # the invoice lists the delivery fee, so its lines add up to the total
    inv = client.get(f"/api/invoices/{stop['date'][:7]}", headers=h).json()
    assert sum(x["amount_paise"] for x in inv["lines"]) == inv["total_paise"]
    assert any(x["name"] == "Delivery fee" for x in inv["lines"])
    yesterday = (utils.today_ist() - timedelta(days=1)).isoformat()
    assert client.post("/api/admin/routes/generate", headers=admin(client), json={"date": yesterday}).status_code == 400
    client.post("/api/agent/trips/end", headers=agent, json={})


def test_trip_left_open_yesterday_does_not_block_today(client):
    agent = login(client, "agent@moonest.in", "agent")
    yesterday = (utils.today_ist() - timedelta(days=1)).isoformat()
    client.portal.call(lambda: get_db().trips.insert_one({"id": "old-trip", "agent_id": "u-agent-ravi", "date": yesterday,
                                                          "slot": "morning", "status": "active", "started_at": "x"}))
    assert client.get("/api/agent/today", headers=agent).json()["trip"] is None
    assert client.post("/api/agent/trips/start", headers=agent, json={"slot": "evening"}).status_code == 200
    client.post("/api/agent/trips/end", headers=agent, json={})


def test_live_tracking_socket_pushes_agent_location(client):
    import json as _json

    h = register(client, "Live Watcher", "live@x.in", "9123400008")
    addr = address(client, h)
    cod_order(client, h, addr, nxt(client))
    client.post("/api/admin/demo/run-tomorrow-today", headers=admin(client))
    delivery = client.get("/api/tracking/today", headers=h).json()[0]
    agent = login(client, "agent@moonest.in", "agent")
    with client.websocket_connect(f"/api/ws/track/{delivery['delivery_id']}") as ws:  # no token: refused
        ws.send_text(_json.dumps({"token": "nope"}))
        with pytest.raises(Exception):
            ws.receive_json()
    token = h["Authorization"].split()[1]
    with client.websocket_connect(f"/api/ws/track/{delivery['delivery_id']}") as ws:
        ws.send_text(_json.dumps({"token": token}))  # token as the first message, not in the URL
        assert ws.receive_json()["type"] == "tracking"
        client.post("/api/agent/trips/start", headers=agent, json={"slot": "morning"})
        client.post("/api/agent/location", headers=agent, json={"lat": 12.9301, "lng": 77.6182})
        for _ in range(4):  # pushes arrive as the agent acts, newest last
            msg = ws.receive_json()
            if msg.get("location"):
                break
        assert msg["location"]["lat"] == 12.9301 and msg["trip_status"] == "active"
    client.post("/api/agent/trips/end", headers=agent, json={})


def test_real_mode_live_tracking_without_demo(client, monkeypatch):
    """Demo mode off: real accounts only, agent signs in with email + password, live tracking works."""
    import json as _json

    ah = admin(client)
    try:
        assert client.put("/api/admin/settings", headers=ah, json={"demo_mode": False}).json()["demo_mode"] is False
        h = register(client, "Real Customer", "real@x.in", "9123400009")
        addr = address(client, h)  # 560034 Koramangala: a real delivery area
        day = nxt(client)
        order = cod_order(client, h, addr, day)
        made = client.post("/api/admin/agents", headers=ah, json={
            "name": "Real Agent", "phone": "9555511111", "pincodes": ["560034"], "email": "ragent@x.in",
            "password": "agentpw1"})
        assert made.status_code == 201 and made.json()["has_password"]
        assert client.post("/api/auth/login", json={"identifier": "agent@moonest.in", "password": "pass1234",
                                                    "role": "agent"}).status_code in (400, 401, 403)  # demo agent is off
        agent = login(client, "ragent@x.in", "agent", "agentpw1")
        assert client.post("/api/admin/routes/generate", headers=ah, json={"date": day}).json()["created"] >= 1
        # pretend it's the delivery day
        d = utils.parse_date(day)
        for mod in ("app.routers.agent", "app.routers.customer", "app.routers.ws"):
            monkeypatch.setattr(f"{mod}.today_ist", lambda: d)
        stop = next(s for s in client.get("/api/agent/today", headers=agent).json()["stops"] if s["ref_id"] == order["id"])
        assert stop["agent_id"] == made.json()["id"]
        token = h["Authorization"].split()[1]
        with client.websocket_connect(f"/api/ws/track/{stop['id']}") as ws:
            ws.send_text(_json.dumps({"token": token}))
            assert ws.receive_json()["trip_status"] == "not_started"
            client.post("/api/agent/trips/start", headers=agent, json={"slot": "morning"})
            client.post("/api/agent/location", headers=agent, json={"lat": 12.931, "lng": 77.62})
            for _ in range(4):
                msg = ws.receive_json()
                if msg.get("location"):
                    break
            assert msg["location"]["lat"] == 12.931 and msg["eta_minutes"] is not None
        # admin can change the agent's password later
        client.post(f"/api/admin/agents/{made.json()['id']}/password", headers=ah, json={"password": "newpass9"})
        login(client, "ragent@x.in", "agent", "newpass9")
        client.post("/api/agent/trips/end", headers=agent, json={})
    finally:
        client.put("/api/admin/settings", headers=ah, json={"demo_mode": True})


def test_real_mode_new_area_subscription_and_order_reach_live_tracking(client, monkeypatch):
    """Demo mode off, like the live app: Admin adds a new area and agent, a customer saves an address
    there, subscribes and orders, the nightly scheduler builds routes, and the agent's trip shows live."""
    import asyncio
    import json as _json
    from app.services.routing import generate_once

    ah = admin(client)
    try:
        client.put("/api/admin/settings", headers=ah, json={"demo_mode": False, "city": "Chennai"})
        cfg = client.get("/api/config").json()
        assert cfg["demo_mode"] is False and cfg["city"] == "Chennai" and cfg["payments_mode"] == "disabled"
        assert client.post("/api/admin/areas", headers=ah, json={"pincode": "600020", "name": "Adyar",
                                                                 "lat": 13.0012, "lng": 80.2565}).status_code == 201
        agent_id = client.post("/api/admin/agents", headers=ah, json={
            "name": "Adyar Agent", "phone": "9555522222", "pincodes": ["600020"], "email": "adyar@x.in",
            "password": "agentpw1"}).json()["id"]
        h = register(client, "Chennai Customer", "chn@x.in", "9123400010")
        assert client.get("/api/serviceability/600099").json()["serviceable"] is False  # unknown pincode refused
        addr = address(client, h, "600020", line2="LB Road, Adyar", lat=13.0035, lng=80.2550)
        assert addr["area"] == "Adyar" and addr["lat"] == 13.0035
        day = nxt(client)
        sub = client.post("/api/subscriptions", headers=h, json={
            "product_id": "aavin-milk-blue", "quantity": 1, "plan_code": "daily", "slot": "morning",
            "start_date": day, "address_id": addr["id"], "payment_method": "cod"})
        assert sub.status_code == 201, sub.text
        assert client.post("/api/wallet/topup", headers=h, json={"amount_paise": 10000}).status_code == 503
        order = cod_order(client, h, addr, day)
        # the nightly scheduler (no admin click) builds the day's routes
        asyncio.run(get_db().route_runs.delete_many({"date": day}))  # other tests share this database
        asyncio.run(generate_once(utils.parse_date(day), "scheduler"))
        d = utils.parse_date(day)
        for mod in ("app.routers.agent", "app.routers.customer", "app.routers.ws"):
            monkeypatch.setattr(f"{mod}.today_ist", lambda: d)
        agent = login(client, "adyar@x.in", "agent", "agentpw1")
        stops = client.get("/api/agent/today", headers=agent).json()["stops"]
        refs = {s["ref_id"] for s in stops}
        assert order["id"] in refs and sub.json()["subscription"]["id"] in refs
        assert all(s["agent_id"] == agent_id for s in stops)
        before = client.get("/api/tracking/today", headers=h).json()
        assert before and all(t["trip_status"] == "not_started" for t in before)
        token = h["Authorization"].split()[1]
        with client.websocket_connect(f"/api/ws/track/{before[0]['delivery_id']}") as ws:
            ws.send_text(_json.dumps({"token": token}))
            assert ws.receive_json()["trip_status"] == "not_started"
            assert client.post("/api/agent/trips/start", headers=agent, json={"slot": "morning"}).status_code == 200
            client.post("/api/agent/location", headers=agent, json={"lat": 13.0060, "lng": 80.2570})
            for _ in range(4):
                msg = ws.receive_json()
                if msg.get("location"):
                    break
            assert msg["trip_status"] == "active" and msg["location"]["lat"] == 13.006
            assert msg["eta_minutes"] is not None
        live = client.get("/api/tracking/today", headers=h).json()
        assert all(t["trip_status"] == "active" and t["location"] for t in live)
        client.post("/api/agent/trips/end", headers=agent, json={})
    finally:
        client.put("/api/admin/settings", headers=ah, json={"demo_mode": True, "city": "Bengaluru"})


def test_area_without_coordinates_uses_pincode_centre(client, monkeypatch):
    async def centre(pincode):
        return {"lat": 13.08, "lng": 80.27}
    monkeypatch.setattr("app.services.geocode.pincode_centre", centre)
    r = client.post("/api/admin/areas", headers=admin(client), json={"pincode": "600001", "name": "George Town"})
    assert r.status_code == 201 and r.json()["lat"] == 13.08 and r.json()["lng"] == 80.27
