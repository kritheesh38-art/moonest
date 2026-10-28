import asyncio
import json
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app import utils
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
    return bearer(c.post("/api/auth/register", json={"name": name, "email": email, "phone": phone, "password": "longpass1"}))


def setup_customer(c, email, phone, qty=2, product="aavin-milk-blue"):
    h = register(c, "Pickup Tester", email, phone)
    addr = c.post("/api/addresses", headers=h, json={"line1": "7, 2nd Main", "pincode": "560034"}).json()
    day = c.get("/api/config").json()["next_cycle_date"]
    sub = c.post("/api/subscriptions", headers=h, json={
        "product_id": product, "quantity": qty, "plan_code": "daily", "slot": "morning", "start_date": day,
        "address_id": addr["id"], "payment_method": "cod"})
    assert sub.status_code == 201, sub.text
    return h, addr, day, sub.json()["subscription"]


def row(items, product_id):
    return next((i for i in items if i["product_id"] == product_id), None)


def test_pickup_list_estimate_then_exact(client):
    ah = login(client, "ritissh", "admin", ADMIN_PASSWORD)
    h, addr, day, _ = setup_customer(client, "pick@x.in", "9123400041", qty=3, product="farm-fresh-1l")
    r = client.post("/api/orders", headers=h, json={"items": [{"product_id": "farm-fresh-1l", "qty": 1}],
                                                    "address_id": addr["id"], "slot": "evening", "delivery_date": day,
                                                    "payment_method": "cod"})
    assert r.status_code == 201, r.text
    client.portal.call(lambda: __import__("app.db", fromlist=["get_db"]).get_db().deliveries.delete_many({"date": day}))
    est = client.get(f"/api/admin/pickup?date={day}", headers=ah).json()
    assert est["estimate"] is True
    ravi = next(a for a in est["agents"] if a["agent_id"] == "u-agent-ravi")
    hm = row(ravi["items"], "farm-fresh-1l")
    assert hm["morning"] >= 3 and hm["evening"] >= 1 and hm["litres"] == hm["qty"] * 1.0 and hm["brand"] == "Farm Fresh"
    # the agent sees only their own list
    agent = login(client, "agent@moonest.in", "agent")
    mine = client.get(f"/api/agent/pickup?date={day}", headers=agent).json()
    assert mine["agent_id"] == "u-agent-ravi" and row(mine["items"], "farm-fresh-1l")["qty"] == hm["qty"]
    # once the routes are built the list is exact, and skipped stops drop out
    client.post("/api/admin/routes/generate", headers=ah, json={"date": day})
    exact = client.get(f"/api/admin/pickup?date={day}", headers=ah).json()
    assert exact["estimate"] is False
    assert row(next(a for a in exact["agents"] if a["agent_id"] == "u-agent-ravi")["items"], "farm-fresh-1l")["qty"] == hm["qty"]
    assert exact["total"]["total_packets"] >= hm["qty"]
    assert client.get("/api/agent/pickup?date=2020-01-01", headers=agent).status_code == 400


def test_skip_reminder_push_and_one_tap_skip(client, monkeypatch):
    from app.services import push, reminders

    h, _, day, sub = setup_customer(client, "remind@x.in", "9123400042")
    keys = {"p256dh": "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
            "auth": "tBHItJI5svbpez7KI4CCXg"}
    client.post("/api/push/subscribe", headers=h, json={"endpoint": "https://fcm.googleapis.com/fcm/send/remind-1", "keys": keys})
    me = client.get("/api/auth/me", headers=h).json()
    sent = []
    monkeypatch.setattr(push, "_send_one", lambda s, payload, key: sent.append((s["user_id"], json.loads(payload))) or 201)
    d = utils.parse_date(day)
    res = client.portal.call(reminders.send_once, d, 22)
    assert res and res["pushes"] >= 1
    assert client.portal.call(reminders.send_once, d, 22) is None  # once per night
    msg = next(p for u, p in sent if u == me["id"])
    assert msg["title"].startswith("Milk tomorrow") and msg["actions"][0]["action"] == "skip"
    assert msg["url"] == "/#/subscriptions" and "Aavin" in msg["body"]
    # pressing "Skip tomorrow" on the notification (no sign-in)
    monkeypatch.setattr("app.routers.subscriptions.next_cycle_date", lambda cutoff: d)
    r = client.post("/api/push/skip", json={"token": msg["skip_token"]})
    assert r.status_code == 200 and r.json()["skipped"] == 1, r.text
    assert day in client.get(f"/api/subscriptions/{sub['id']}", headers=h).json()["skips"]
    assert client.post("/api/push/skip", json={"token": msg["skip_token"] + "x"}).status_code == 400
    # a link can't be used after the cutoff
    late = reminders.skip_token(me["id"], [sub["id"]], d - timedelta(days=5), 22)
    assert client.post("/api/push/skip", json={"token": late}).json()["detail"].startswith("Too late")
    # customers can turn the reminder off
    assert client.get("/api/push/prefs", headers=h).json() == {"skip_reminders": True}
    client.put("/api/push/prefs", headers=h, json={"skip_reminders": False})
    sent.clear()
    client.portal.call(reminders.send_skip_reminders, d + timedelta(days=1), 22)
    assert not [p for u, p in sent if u == me["id"]]


def test_dashboard_stats(client, monkeypatch):
    ah = login(client, "ritissh", "admin", ADMIN_PASSWORD)
    h, addr, day, _ = setup_customer(client, "stats@x.in", "9123400043", qty=4)
    d = utils.parse_date(day)
    client.post("/api/admin/routes/generate", headers=ah, json={"date": day})
    agent = login(client, "agent@moonest.in", "agent")
    for mod in ("app.routers.agent", "app.routers.admin"):
        monkeypatch.setattr(f"{mod}.today_ist", lambda: d)
    client.post("/api/agent/trips/start", headers=agent, json={"slot": "morning"})
    stops = [s for s in client.get("/api/agent/today", headers=agent).json()["stops"] if s["status"] == "pending"]
    for s in stops:
        assert client.post(f"/api/agent/deliveries/{s['id']}/delivered", headers=agent).status_code == 200
    client.post("/api/agent/trips/end", headers=agent, json={})
    st = client.get("/api/admin/stats?days=14", headers=ah).json()
    assert len(st["days"]) == 14 and st["to"] == day
    today = st["days"][-1]
    assert today["delivered"] == len(stops) and today["litres"] >= 2.0 and today["revenue_paise"] > 0
    assert st["totals"]["new_customers"] >= 1 and st["totals"]["cash_owed_paise"] > 0
    assert st["brands"][0]["litres"] > 0
    assert client.get("/api/admin/stats", headers=login(client, "customer@moonest.in")).status_code == 403
