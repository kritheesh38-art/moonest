"""Business numbers for the Admin dashboard: daily milk litres, revenue, deliveries, new customers,
top brands, and cash still owed."""
from datetime import date, timedelta

from ..db import get_db
from .pickup import _litres


async def dashboard(end: date, days: int = 30) -> dict:
    db = get_db()
    start = end - timedelta(days=days - 1)
    span = [(start + timedelta(days=i)).isoformat() for i in range(days)]
    rows = {d: {"date": d, "litres": 0.0, "revenue_paise": 0, "delivered": 0, "missed": 0, "new_customers": 0}
            for d in span}
    products = {p["id"]: p async for p in db.products.find({}, {"id": 1, "brand": 1, "unit": 1, "category": 1})}
    brands: dict[str, dict] = {}
    async for s in db.deliveries.find({"date": {"$gte": span[0], "$lte": span[-1]}}):
        r = rows.get(s["date"])
        if not r:
            continue
        if s["status"] == "delivered":
            r["delivered"] += 1
            r["revenue_paise"] += s.get("amount_paise", 0)
            for it in s["items"]:
                p = products.get(it.get("product_id"), {})
                litres = _litres(it.get("unit") or p.get("unit", ""), it["qty"], p.get("category", "milk"))
                r["litres"] += litres
                b = brands.setdefault(p.get("brand") or "Other", {"litres": 0.0, "revenue_paise": 0})
                b["litres"] += litres
                b["revenue_paise"] += it.get("price_paise", 0) * it["qty"]
        elif s["status"] in ("failed", "skipped"):
            r["missed"] += 1
    async for u in db.users.find({"roles": "customer", "created_at": {"$gte": span[0]}}, {"created_at": 1}):
        r = rows.get(u["created_at"][:10])
        if r:
            r["new_customers"] += 1
    for r in rows.values():
        r["litres"] = round(r["litres"], 2)
    dues: dict[str, int] = {}  # same rule as core.cod_balance, for every customer at once
    async for e in db.cod_ledger.find({}, {"user_id": 1, "type": 1, "amount_paise": 1}):
        sign = 1 if e["type"] == "due" else -1 if e["type"] in ("collected", "waived") else 0
        dues[e["user_id"]] = dues.get(e["user_id"], 0) + sign * e["amount_paise"]
    owed = sum(v for v in dues.values() if v > 0)
    series = [rows[d] for d in span]
    return {
        "from": span[0], "to": span[-1], "days": series,
        "totals": {"litres": round(sum(r["litres"] for r in series), 1),
                   "revenue_paise": sum(r["revenue_paise"] for r in series),
                   "delivered": sum(r["delivered"] for r in series),
                   "missed": sum(r["missed"] for r in series),
                   "new_customers": sum(r["new_customers"] for r in series),
                   "cash_owed_paise": owed,
                   "active_subscriptions": await db.subscriptions.count_documents({"status": "active"})},
        "brands": sorted(({"brand": k, "litres": round(v["litres"], 1), "revenue_paise": v["revenue_paise"]}
                          for k, v in brands.items()), key=lambda b: -b["litres"]),
    }
