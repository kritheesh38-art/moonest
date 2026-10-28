from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, EmailStr, Field, field_validator

from .utils import normalize_phone, parse_date

Phone = Annotated[str, AfterValidator(normalize_phone)]
Role = Literal["customer", "agent", "admin"]
Slot = Literal["morning", "evening"]
PlanCode = Literal["daily", "alternate", "custom"]
SubPayment = Literal["autopay", "wallet", "cod"]
OrderPayment = Literal["razorpay", "wallet", "cod"]
MissedPref = Literal["wallet_credit", "redeliver"]


def _iso_date(v: str) -> str:
    parse_date(v)
    return v


IsoDate = Annotated[str, AfterValidator(_iso_date)]


# ---- auth ----
class OtpRequest(BaseModel):
    phone: Phone | None = None
    email: EmailStr | None = None
    role: Role = "customer"


class OtpVerify(OtpRequest):
    code: str = Field(min_length=6, max_length=6)
    name: str | None = Field(default=None, max_length=60)


class RegisterIn(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    email: EmailStr
    phone: Phone
    password: str = Field(min_length=8, max_length=128)
    role: Literal["customer", "agent"] = "customer"


class LoginIn(BaseModel):
    identifier: str = Field(min_length=3, max_length=120)  # email or 10-digit mobile
    password: str = Field(min_length=1, max_length=128)
    role: Role = "customer"


class ProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    email: EmailStr | None = None
    phone: Phone | None = None
    missed_pref: MissedPref | None = None


# ---- addresses ----
class AddressIn(BaseModel):
    label: str = Field(default="Home", max_length=30)
    line1: str = Field(min_length=3, max_length=120)
    line2: str = Field(default="", max_length=120)
    landmark: str = Field(default="", max_length=80)
    pincode: str = Field(pattern=r"^\d{6}$")
    lat: float | None = None
    lng: float | None = None
    contact_phone: Phone | None = None
    is_default: bool = False


# ---- orders ----
class CartItem(BaseModel):
    product_id: str
    qty: int = Field(ge=1, le=20)


class OrderIn(BaseModel):
    items: list[CartItem] = Field(min_length=1)
    address_id: str
    slot: Slot
    delivery_date: IsoDate
    payment_method: OrderPayment
    note: str = Field(default="", max_length=200)


class RazorpayVerify(BaseModel):
    payment_id: str  # our payment record id
    razorpay_order_id: str | None = None
    razorpay_payment_id: str | None = None
    razorpay_signature: str | None = None
    demo_outcome: Literal["success", "failure"] | None = None
    method: str = Field(default="", max_length=20)  # shown on receipts: upi / card / netbanking
    method_detail: str = Field(default="", max_length=60)


# ---- subscriptions ----
class SubscriptionIn(BaseModel):
    product_id: str
    quantity: int = Field(ge=1, le=10)
    plan_code: PlanCode
    custom_days: list[int] = Field(default_factory=list)  # 0=Mon .. 6=Sun
    slot: Slot
    start_date: IsoDate
    address_id: str
    payment_method: SubPayment

    @field_validator("custom_days")
    @classmethod
    def _days(cls, v):
        if any(d < 0 or d > 6 for d in v):
            raise ValueError("Days must be between 0 (Mon) and 6 (Sun)")
        return sorted(set(v))


class SubscriptionUpdate(BaseModel):
    quantity: int | None = Field(default=None, ge=1, le=10)
    plan_code: PlanCode | None = None
    custom_days: list[int] | None = None
    slot: Slot | None = None
    payment_method: SubPayment | None = None


class SkipIn(BaseModel):
    date: IsoDate
    skip: bool = True


class PauseIn(BaseModel):
    start_date: IsoDate
    end_date: IsoDate


class AddressChangeIn(BaseModel):
    address_id: str


# ---- wallet ----
class TopupIn(BaseModel):
    amount_paise: int = Field(ge=100 * 100, le=20000 * 100)  # ₹100 – ₹20,000


# ---- agent ----
class LocationIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    accuracy: float | None = None
    heading: float | None = None
    speed: float | None = None


class TripStart(BaseModel):
    slot: Slot


class FailIn(BaseModel):
    reason: Literal[
        "customer_unavailable", "address_not_found", "gate_locked", "refused", "out_of_stock", "other"
    ]
    note: str = Field(default="", max_length=200)


class CashIn(BaseModel):
    amount_paise: int = Field(ge=1)


class EndTripIn(BaseModel):
    handoff_note: str = Field(default="", max_length=300)
    cash_handed_over_paise: int = Field(default=0, ge=0)


# ---- admin ----
Category = Literal["milk", "dairy"]


class ProductIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    brand: str = ""
    supplier: str = ""
    category: Category = "milk"
    unit: str = Field(min_length=1, max_length=40)
    price_paise: int = Field(ge=100, le=10_000_000)
    mrp_paise: int | None = None
    description: str = ""
    image: str = ""
    tags: list[str] = Field(default_factory=list)
    active: bool = True
    subscribable: bool | None = None  # default: milk yes, dairy no
    # Pouch colour variants: products sharing a group show as one item with a colour picker
    group: str | None = None
    pack_label: str | None = None
    pack_color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    fat: str | None = None


class ProductUpdate(BaseModel):
    name: str | None = None
    brand: str | None = None
    supplier: str | None = None
    category: Category | None = None
    unit: str | None = None
    price_paise: int | None = Field(default=None, ge=100, le=10_000_000)
    mrp_paise: int | None = None
    description: str | None = None
    image: str | None = None
    tags: list[str] | None = None
    active: bool | None = None
    subscribable: bool | None = None
    group: str | None = None
    pack_label: str | None = None
    pack_color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    fat: str | None = None
    sort: int | None = None


class PlanUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    discount_pct: float | None = Field(default=None, ge=0, le=50)
    active: bool | None = None
    perks: list[str] | None = None


class SettingsUpdate(BaseModel):
    demo_mode: bool | None = None
    city: str | None = Field(default=None, min_length=2, max_length=40)
    skip_cutoff_hour: int | None = Field(default=None, ge=12, le=23)
    max_pause_days: int | None = Field(default=None, ge=1, le=90)
    delivery_fee_paise: int | None = Field(default=None, ge=0)
    free_delivery_above_paise: int | None = Field(default=None, ge=0)


class AgentIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    phone: Phone
    pincodes: list[str] = Field(default_factory=list)
    # Optional sign-in by email + password (works without SMS, e.g. with demo mode off)
    email: EmailStr | None = None
    password: str | None = Field(default=None, min_length=6, max_length=128)


class AgentPasswordIn(BaseModel):
    password: str = Field(min_length=6, max_length=128)
    email: EmailStr | None = None


class AssignIn(BaseModel):
    delivery_ids: list[str]
    agent_id: str


class AreaIn(BaseModel):
    pincode: str = Field(pattern=r"^\d{6}$")
    name: str
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


class RefundIn(BaseModel):
    amount_paise: int = Field(ge=1)
    reason: str = Field(min_length=2, max_length=200)


class GenerateIn(BaseModel):
    date: IsoDate
