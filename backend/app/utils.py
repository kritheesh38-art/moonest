import math
import re
import uuid
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from . import config

IST = ZoneInfo(config.TIMEZONE)

# Indian mobile numbers: exactly 10 digits, starting with 6-9.
PHONE_RE = re.compile(r"^[6-9]\d{9}$")
PHONE_ERROR = "Enter a valid 10-digit mobile number"


def normalize_phone(raw: str) -> str:
    """Return the 10-digit number or raise ValueError.

    Formatting characters and a leading +91 / 0 are tolerated (e.g. pasted
    "+91 98765-43210"), but the number itself must be exactly 10 digits.
    """
    digits = re.sub(r"\D", "", raw or "")
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if not PHONE_RE.match(digits):
        raise ValueError(PHONE_ERROR)
    return digits


def e164(phone10: str) -> str:
    return f"+91{phone10}"


def new_id() -> str:
    return uuid.uuid4().hex


def now_ist() -> datetime:
    return datetime.now(IST)


def now_iso() -> str:
    return now_ist().isoformat()


def today_ist() -> date:
    return now_ist().date()


def parse_date(s: str) -> date:
    return date.fromisoformat(s)


def next_cycle_date(cutoff_hour: int, now: datetime | None = None) -> date:
    """First delivery date that can still be changed (skip/pause/address/order).

    Changes for date D are allowed until D-1 at `cutoff_hour` (IST).
    """
    now = now or now_ist()
    tomorrow = now.date() + timedelta(days=1)
    return tomorrow if now.hour < cutoff_hour else tomorrow + timedelta(days=1)


def can_change_date(d: date, cutoff_hour: int, now: datetime | None = None) -> bool:
    return d >= next_cycle_date(cutoff_hour, now)


def haversine_km(lat1, lng1, lat2, lng2) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def rupees(paise: int) -> str:
    return f"₹{paise / 100:,.2f}".replace(".00", "")


def clean(doc: dict | None) -> dict | None:
    if doc is None:
        return None
    doc = dict(doc)
    doc.pop("_id", None)
    return doc
