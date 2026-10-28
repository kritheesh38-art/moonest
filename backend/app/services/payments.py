"""Razorpay integration: one-off checkout orders, wallet top-ups, UPI AutoPay mandates.

When Razorpay keys are not configured and DEMO_MODE is on, payments are simulated so the
whole flow can be exercised end to end. Without keys and without demo mode, online payment
endpoints answer 503 with a clear message.
"""
import hashlib
import hmac
import time

import httpx
from fastapi import HTTPException

from .. import config

API = "https://api.razorpay.com/v1"


def mode() -> str:
    if config.razorpay_enabled():
        return "live"
    if config.DEMO_MODE:
        return "demo"
    return "disabled"


def ensure_available():
    if mode() == "disabled":
        raise HTTPException(503, "Online payments are not configured yet. Please choose Wallet or Cash on Delivery.")


async def _post(path: str, payload: dict) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(f"{API}{path}", json=payload,
                              auth=(config.RAZORPAY_KEY_ID, config.RAZORPAY_KEY_SECRET))
    if r.status_code >= 300:
        try:
            msg = r.json().get("error", {}).get("description", "")
        except ValueError:
            msg = ""
        raise HTTPException(502, f"Payment gateway error. {msg}".strip())
    return r.json()


async def create_order(amount_paise: int, receipt: str, notes: dict | None = None) -> dict:
    ensure_available()
    if mode() == "demo":
        return {"id": f"order_demo_{receipt[:12]}", "amount": amount_paise, "currency": "INR", "demo": True}
    return await _post("/orders", {"amount": amount_paise, "currency": "INR",
                                   "receipt": receipt[:40], "notes": notes or {}})


def verify_signature(order_id: str, payment_id: str, signature: str) -> bool:
    if not config.RAZORPAY_KEY_SECRET:
        return False
    expected = hmac.new(config.RAZORPAY_KEY_SECRET.encode(), f"{order_id}|{payment_id}".encode(),
                        hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")


# ---- UPI AutoPay (Razorpay recurring payments with UPI token) ----
async def create_customer(name: str, phone10: str, email: str = "") -> str:
    if mode() == "demo":
        return f"cust_demo_{phone10}"
    data = await _post("/customers", {"name": name or "MooNest customer", "contact": f"+91{phone10}",
                                      "email": email or None, "fail_existing": "0"})
    return data["id"]


async def create_mandate_order(customer_id: str, max_amount_paise: int, receipt: str) -> dict:
    """Authorisation order for a UPI AutoPay mandate (₹1 auth, variable 'as presented' debits)."""
    ensure_available()
    if mode() == "demo":
        return {"id": f"order_demo_mandate_{receipt[:10]}", "amount": 100, "currency": "INR", "demo": True}
    return await _post("/orders", {
        "amount": 100, "currency": "INR", "customer_id": customer_id, "method": "upi",
        "receipt": receipt[:40],
        "token": {"max_amount": max_amount_paise, "expire_at": int(time.time()) + 365 * 86400,
                  "frequency": "as_presented"},
    })


async def fetch_payment(payment_id: str) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(f"{API}/payments/{payment_id}",
                             auth=(config.RAZORPAY_KEY_ID, config.RAZORPAY_KEY_SECRET))
    r.raise_for_status()
    return r.json()


async def charge_mandate(customer_id: str, token_id: str, amount_paise: int, receipt: str,
                         phone10: str, email: str = "") -> dict:
    """Debit a subscription delivery against the AutoPay mandate."""
    if mode() == "demo" or token_id.startswith("token_demo"):
        return {"razorpay_payment_id": f"pay_demo_{receipt[:12]}", "status": "captured", "demo": True}
    order = await _post("/orders", {"amount": amount_paise, "currency": "INR", "receipt": receipt[:40],
                                    "payment_capture": True})
    return await _post("/payments/create/recurring", {
        "email": email or "noreply@moonest.in", "contact": f"+91{phone10}", "amount": amount_paise,
        "currency": "INR", "order_id": order["id"], "customer_id": customer_id,
        "token": token_id, "recurring": "1", "description": "MooNest subscription delivery",
    })
