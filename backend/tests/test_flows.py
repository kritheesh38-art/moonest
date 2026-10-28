import os
from datetime import datetime, timedelta

os.environ["MONGO_URL"] = "mongomock://"
os.environ["DEMO_MODE"] = "true"
os.environ["JWT_SECRET"] = "test-secret-that-is-long-enough-for-hs256"
os.environ["RAZORPAY_KEY_ID"] = ""
os.environ["RAZORPAY_KEY_SECRET"] = ""

import pytest
from fastapi.testclient import TestClient

from app import utils
from app.main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def login(c, phone, role="customer", name=None):
    r = c.post("/api/auth/request-otp", json={"phone": phone, "role": role})
    assert r.status_code == 200, r.text
    r = c.post("/api/auth/verify-otp", json={"phone": phone, "role": role, "code": r.json()["dev_otp"], "name": name})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


# ---------------- phone validation ----------------
@pytest.mark.parametrize("raw,ok", [
    ("9876543210", True), ("+91 98765-43210", True), ("09876543210", True),
    ("987654321", False), ("98765432101", False), ("5876543210", False), ("98765abcde", False), ("", False),
])
def test_normalize_phone(raw, ok):
    if ok:
        assert utils.normalize_phone(raw) == "9876543210"
    else:
        with pytest.raises(ValueError):
            utils.normalize_phone(raw)


def test_api_rejects_bad_phone(client):
    for bad in ("12345", "98765432101", "5876543210"):
        r = client.post("/api/auth/request-otp", json={"phone": bad})
        assert r.status_code == 422


def test_agent_login_requires_registration(client):
    r = client.post("/api/auth/request-otp", json={"phone": "9811111111", "role": "agent"})
    assert r.status_code == 403


def test_next_cycle_date():
    ist = utils.IST
    assert utils.next_cycle_date(22, datetime(2026, 10, 20, 21, 59, tzinfo=ist)).isoformat() == "2026-10-21"
    assert utils.next_cycle_date(22, datetime(2026, 10, 20, 22, 0, tzinfo=ist)).isoformat() == "2026-10-22"


# ---------------- end-to-end ----------------
def test_full_flow(client, monkeypatch):
    c = client
    h = login(c, "9876543210", name="Priya")
    me = c.get("/api/auth/me", headers=h).json()
    assert me["name"] == "Priya" and me["phone"] == "9876543210"

    assert c.post("/api/addresses", headers=h, json={"line1": "12 MG Road", "pincode": "011001"}).status_code in (400, 422)
    addr = c.post("/api/addresses", headers=h, json={"line1": "12, 5th Cross", "pincode": "560034"}).json()

    cfg = c.get("/api/config").json()
    nxt = cfg["next_cycle_date"]
    products = c.get("/api/products").json()
    milk = products[0]

    # one-off COD order
    r = c.post("/api/orders", headers=h, json={"items": [{"product_id": milk["id"], "qty": 2}],
                                               "address_id": addr["id"], "slot": "morning",
                                               "delivery_date": nxt, "payment_method": "cod"})
    assert r.status_code == 201, r.text
    cod_order = r.json()["order"]
    assert cod_order["status"] == "confirmed" and cod_order["payment_status"] == "cod_pending"

    # past date rejected
    r = c.post("/api/orders", headers=h, json={"items": [{"product_id": milk["id"], "qty": 1}],
                                               "address_id": addr["id"], "slot": "morning",
                                               "delivery_date": utils.today_ist().isoformat(), "payment_method": "cod"})
    assert r.status_code == 400

    # Razorpay (demo) order: fail, then retry and succeed
    r = c.post("/api/orders", headers=h, json={"items": [{"product_id": milk["id"], "qty": 1}],
                                               "address_id": addr["id"], "slot": "evening",
                                               "delivery_date": nxt, "payment_method": "razorpay"})
    assert r.status_code == 201
    rz = r.json()
    assert rz["order"]["status"] == "pending" and rz["payment"]["demo"]
    assert c.post("/api/payments/verify", headers=h, json={"payment_id": rz["payment"]["payment_id"],
                                                           "demo_outcome": "failure"}).json()["status"] == "failed"
    pay = c.post(f"/api/orders/{rz['order']['id']}/retry-payment", headers=h).json()
    assert c.post("/api/payments/verify", headers=h, json={"payment_id": pay["payment_id"],
                                                           "demo_outcome": "success"}).json()["status"] == "paid"
    assert c.get(f"/api/orders/{rz['order']['id']}", headers=h).json()["status"] == "confirmed"

    # wallet: insufficient, top up, pay
    body = {"items": [{"product_id": milk["id"], "qty": 1}], "address_id": addr["id"], "slot": "morning",
            "delivery_date": nxt, "payment_method": "wallet"}
    assert c.post("/api/orders", headers=h, json=body).status_code == 402
    t = c.post("/api/wallet/topup", headers=h, json={"amount_paise": 50000}).json()
    c.post("/api/payments/verify", headers=h, json={"payment_id": t["payment_id"], "demo_outcome": "success"})
    assert c.get("/api/wallet", headers=h).json()["balance_paise"] == 50000
    w_order = c.post("/api/orders", headers=h, json=body).json()["order"]
    assert w_order["payment_status"] == "paid"
    # cancel → refund to wallet
    assert c.post(f"/api/orders/{w_order['id']}/cancel", headers=h).json()["status"] == "cancelled"
    assert c.get("/api/wallet", headers=h).json()["balance_paise"] == 50000

    # subscriptions
    plans = {p["code"]: p for p in c.get("/api/plans").json()}
    assert set(plans) == {"daily", "alternate", "custom"}
    r = c.post("/api/subscriptions", headers=h, json={"product_id": milk["id"], "quantity": 1, "plan_code": "custom",
                                                      "custom_days": [], "slot": "morning", "start_date": nxt,
                                                      "address_id": addr["id"], "payment_method": "cod"})
    assert r.status_code == 422
    r = c.post("/api/subscriptions", headers=h, json={"product_id": milk["id"], "quantity": 2, "plan_code": "daily",
                                                      "slot": "morning", "start_date": nxt,
                                                      "address_id": addr["id"], "payment_method": "wallet"})
    assert r.status_code == 201, r.text
    sub = r.json()["subscription"]
    assert sub["per_delivery_paise"] == round(milk["price_paise"] * 0.95) * 2

    # skip / unskip, pause limits
    s2 = c.post(f"/api/subscriptions/{sub['id']}/skip", headers=h, json={"date": nxt}).json()
    assert nxt in s2["skips"]
    assert c.post(f"/api/subscriptions/{sub['id']}/skip", headers=h,
                  json={"date": utils.today_ist().isoformat()}).status_code == 400
    c.post(f"/api/subscriptions/{sub['id']}/skip", headers=h, json={"date": nxt, "skip": False})
    start = utils.parse_date(nxt) + timedelta(days=3)
    assert c.post(f"/api/subscriptions/{sub['id']}/pause", headers=h, json={
        "start_date": start.isoformat(), "end_date": (start + timedelta(days=30)).isoformat()}).status_code == 422
    s3 = c.post(f"/api/subscriptions/{sub['id']}/pause", headers=h, json={
        "start_date": start.isoformat(), "end_date": (start + timedelta(days=4)).isoformat()}).json()
    assert any(u["state"] == "paused" for u in s3["upcoming"])

    # AutoPay subscription (demo mandate)
    r = c.post("/api/subscriptions", headers=h, json={"product_id": products[2]["id"], "quantity": 1,
                                                      "plan_code": "alternate", "slot": "evening", "start_date": nxt,
                                                      "address_id": addr["id"], "payment_method": "autopay"}).json()
    assert r["subscription"]["status"] == "pending_mandate"
    c.post("/api/payments/verify", headers=h, json={"payment_id": r["payment"]["payment_id"], "demo_outcome": "success"})
    assert c.get(f"/api/subscriptions/{r['subscription']['id']}", headers=h).json()["status"] == "active"

    # address change takes effect next cycle
    addr2 = c.post("/api/addresses", headers=h, json={"label": "Office", "line1": "HSR Sector 2", "pincode": "560102"}).json()
    s4 = c.post(f"/api/subscriptions/{sub['id']}/address", headers=h, json={"address_id": addr2["id"]}).json()
    assert s4["pending_address"]["id"] == addr2["id"] and s4["pending_effective_date"] == nxt

    # admin updates price → reflected in plans/subscriptions
    r = c.post("/api/auth/login", json={"identifier": "ritissh", "password": "test-admin-pw", "role": "admin"})
    ah = {"Authorization": f"Bearer {r.json()['token']}"}
    c.put(f"/api/admin/products/{milk['id']}", headers=ah, json={"price_paise": 6000})
    assert c.get(f"/api/subscriptions/{sub['id']}", headers=h).json()["per_delivery_paise"] == 5700 * 2

    # generate routes for nxt (pretend it's that day) and run the agent flow
    gen = c.post("/api/admin/routes/generate", headers=ah, json={"date": nxt}).json()
    assert gen["created"] >= 3  # COD order, razorpay order, daily sub (alternate sub on start day)
    monkeypatch.setattr("app.routers.agent.today_ist", lambda: utils.parse_date(nxt))
    gh = login(c, "9000000001", role="agent")  # Ravi covers 560034
    route = c.get("/api/agent/today", headers=gh).json()
    assert len(route["stops"]) >= 3
    assert c.post("/api/agent/location", headers=gh, json={"lat": 12.93, "lng": 77.62}).status_code == 409
    c.post("/api/agent/trips/start", headers=gh, json={"slot": "morning"})
    assert c.post("/api/agent/location", headers=gh, json={"lat": 12.93, "lng": 77.62}).status_code == 200

    morning = [s for s in route["stops"] if s["slot"] == "morning"]
    cod_stop = next(s for s in morning if s["kind"] == "order")
    # the daily sub moved to the HSR address (560102) via the address change → Suresh's route
    sh = login(c, "9000000002", role="agent")
    sub_stop = next(s for s in c.get("/api/agent/today", headers=sh).json()["stops"] if s["kind"] == "subscription")
    assert sub_stop["address"]["pincode"] == "560102"
    r = c.post(f"/api/agent/deliveries/{cod_stop['id']}/delivered", headers=gh,
               data={"cash_paise": "0"})
    assert r.status_code == 200 and r.json()["status"] == "delivered"
    assert c.get(f"/api/orders/{cod_order['id']}", headers=h).json()["status"] == "delivered"
    assert c.get("/api/auth/me", headers=h).json()["cod_due_paise"] == cod_order["total_paise"]
    cash = c.post(f"/api/agent/deliveries/{cod_stop['id']}/cash", headers=gh,
                  json={"amount_paise": cod_order["total_paise"]}).json()
    assert cash["cod_due_paise"] == 0 and cash["tally"]["cash_collected_paise"] == cod_order["total_paise"]

    bal_before = c.get("/api/wallet", headers=h).json()["balance_paise"]
    c.post(f"/api/agent/deliveries/{sub_stop['id']}/failed", headers=sh, json={"reason": "gate_locked"})
    assert c.get("/api/wallet", headers=h).json()["balance_paise"] == bal_before + sub_stop["amount_paise"]

    notes = c.get("/api/notifications", headers=h).json()
    assert any(n["title"] == "Delivered" for n in notes)
    end = c.post("/api/agent/trips/end", headers=gh, json={"handoff_note": "ok", "cash_handed_over_paise": 100}).json()
    assert end["status"] == "ended"

    cod = c.get("/api/admin/cod", headers=ah).json()
    assert cod["agents"][0]["amount_paise"] == cod_order["total_paise"]

    # role protection
    assert c.get("/api/admin/overview", headers=h).status_code == 403
    assert c.get("/api/agent/today", headers=h).status_code == 403
