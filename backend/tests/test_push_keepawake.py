import base64
import json
import os

import pytest
from fastapi.testclient import TestClient

from app import config
from app.db import real_db
from app.main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def customer(c):
    r = c.post("/api/auth/login", json={"identifier": "customer@moonest.in", "password": "pass1234"})
    return {"Authorization": f"Bearer {r.json()['token']}"}


def device():
    """A browser's push subscription keys, like PushManager.subscribe() makes."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    priv = ec.generate_private_key(ec.SECP256R1())
    pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    auth = os.urandom(16)
    return priv, {"p256dh": b64(pub), "auth": b64(auth)}, auth


def test_push_key_is_made_once_and_kept(client, monkeypatch):
    from app.services import push

    monkeypatch.setattr(push, "_vapid", None)  # each test module starts a fresh database
    k1 = client.get("/api/push/key").json()
    assert k1["enabled"] and len(unb64(k1["public_key"])) == 65  # uncompressed P-256 point
    assert client.get("/api/push/key").json()["public_key"] == k1["public_key"]
    saved = client.portal.call(lambda: real_db().settings.find_one({"key": "vapid"}))
    assert "BEGIN PRIVATE KEY" in saved["private_pem"]


def test_notification_is_pushed_encrypted_to_the_device(client, monkeypatch):
    import http_ece
    import pywebpush

    h = customer(client)
    priv, keys, auth = device()
    endpoint = "https://fcm.googleapis.com/fcm/send/test-device-1"
    assert client.post("/api/push/subscribe", headers=h, json={"endpoint": endpoint, "keys": keys}).status_code == 200
    sent = []

    class Resp:
        status_code = 201
        text = ""
        headers: dict = {}

    def fake_post(url, data=None, headers=None, timeout=None, **kw):
        sent.append((url, data, headers))
        return Resp()
    monkeypatch.setattr(pywebpush.requests, "post", fake_post)
    assert client.post("/api/push/test", headers=h).json()["sent"] == 1
    url, data, headers = sent[0]
    assert url == endpoint and headers["ttl"] and headers["Urgency"] == "high"
    assert headers["Authorization"].startswith("vapid t=") and client.get("/api/push/key").json()["public_key"] in headers["Authorization"]
    msg = json.loads(http_ece.decrypt(data, private_key=priv, auth_secret=auth, version="aes128gcm"))
    assert msg["title"] == "Notifications are on" and msg["url"] == "/#/notifications"


def test_app_notifications_push_and_dead_devices_are_dropped(client, monkeypatch):
    from app.services import push
    from app.services.notify import notify

    h = customer(client)
    _, keys, _ = device()
    gone = "https://updates.push.services.mozilla.com/wpush/v2/gone-device"
    client.post("/api/push/subscribe", headers=h, json={"endpoint": gone, "keys": keys})
    got = []

    def fake_send_one(sub, payload, key):
        got.append((sub["endpoint"], json.loads(payload)))
        return 410 if sub["endpoint"] == gone else 201
    monkeypatch.setattr(push, "_send_one", fake_send_one)

    async def run():
        await notify("u-demo-customer", "Your milk is on the way", "Ravi has started.", "tracking", "d1")
        for t in list(push._tasks):
            await t
    client.portal.call(run)
    by = dict(got)
    assert by[gone]["url"] == "/#/track" and by[gone]["tag"] == "tracking:d1"
    assert client.portal.call(lambda: real_db().push_subs.find_one({"endpoint": gone})) is None  # unsubscribed device removed
    assert client.post("/api/push/subscribe", json={"endpoint": gone, "keys": keys}).status_code == 401
    assert client.post("/api/push/subscribe", headers=h, json={"endpoint": "http://insecure", "keys": keys}).status_code == 422


def test_keep_awake_visits_own_address(monkeypatch):
    import asyncio

    import httpx

    from app import main

    visits = []

    class FakeClient:
        def __init__(self, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, url):
            visits.append(url)
            if len(visits) >= 2:
                raise asyncio.CancelledError
    monkeypatch.setattr(config, "KEEP_AWAKE_URL", "https://moonest.example.com")
    monkeypatch.setattr(config, "KEEP_AWAKE_MINUTES", 0)
    monkeypatch.setattr(httpx, "AsyncClient", FakeClient)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(main.keep_awake())
    assert visits == ["https://moonest.example.com/api/health"] * 2
