import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env")


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


# Demo mode: test shortcuts for trying the app. On: OTPs shown on screen, test payments when Razorpay
# keys are missing, any pincode accepted as a test area, demo accounts and one-tap sign-in, "Run
# tomorrow's deliveries today", agent self-sign-up. The env value is the start-up default; admins can
# switch it in the app (Admin → Overview), which is saved in settings and wins on later starts.
DEMO_MODE = _bool("DEMO_MODE", True)
DEMO_ENV = DEMO_MODE  # as started; decides start-up defaults (database, secret), never changes at runtime
# Seeded demo accounts: they can only sign in while demo mode is on
DEMO_ACCOUNT_IDS = {"u-agent-ravi", "u-agent-suresh", "u-demo-customer"}
SEED_DEMO_DATA = _bool("SEED_DEMO_DATA", True)

# Without MONGO_URL, a demo server uses the in-memory test database (resets on restart),
# so it starts on any host with zero settings. Production must set MONGO_URL.
MONGO_URL = os.getenv("MONGO_URL") or ("mongomock://" if DEMO_MODE else "mongodb://localhost:27017")
DB_NAME = os.getenv("DB_NAME", "moonest")
# Without JWT_SECRET, a demo server makes a random one per start (everyone signs in again after a
# restart). check_production_safety() refuses to run production without a real one.
JWT_SECRET = os.getenv("JWT_SECRET") or ("change-me-in-production" if not DEMO_MODE else secrets.token_hex(32))
# Reverse geocoding for "Use my current location" (OpenStreetMap Nominatim by default; empty = off)
GEOCODER_URL = os.getenv("GEOCODER_URL", "https://nominatim.openstreetmap.org/reverse")
PHOTON_URL = os.getenv("PHOTON_URL", "https://photon.komoot.io/reverse")  # second lookup service; empty = off
# Address search as you type. The most precise for India: Google Places (GOOGLE_MAPS_API_KEY, needs
# Places API (New) enabled) or Ola Maps (OLA_MAPS_API_KEY). Without a key: free OpenStreetMap search
# via Photon (PHOTON_URL). Keys stay on the server.
GOOGLE_MAPS_API_KEY = os.getenv("GOOGLE_MAPS_API_KEY", "")
OLA_MAPS_API_KEY = os.getenv("OLA_MAPS_API_KEY", "")
JWT_TTL_HOURS = int(os.getenv("JWT_TTL_HOURS", "720"))

RAZORPAY_KEY_ID = os.getenv("RAZORPAY_KEY_ID", "")
RAZORPAY_KEY_SECRET = os.getenv("RAZORPAY_KEY_SECRET", "")

TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM_NUMBER = os.getenv("TWILIO_FROM_NUMBER", "")



def place_search_provider() -> str:
    if GOOGLE_MAPS_API_KEY:
        return "google"
    if OLA_MAPS_API_KEY:
        return "ola"
    return "osm" if PHOTON_URL else ""


UPLOAD_DIR = Path(os.getenv("UPLOAD_DIR") or str(ROOT / "uploads"))
PUBLIC_BASE_URL = os.getenv("PUBLIC_BASE_URL", "")

# Push notifications (Web Push). Keys are made automatically; set VAPID_PRIVATE_KEY (PEM) only to bring your own.
PUSH_ENABLED = _bool("PUSH_ENABLED", True)
VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY", "")
VAPID_CONTACT = os.getenv("VAPID_CONTACT", "mailto:support@moonest.app")

# Keep a free host (Render free sleeps after ~15 idle minutes) awake by visiting our own address.
# Render sets RENDER_EXTERNAL_URL itself; elsewhere set KEEP_AWAKE_URL. KEEP_AWAKE=false turns it off.
KEEP_AWAKE = _bool("KEEP_AWAKE", True)
KEEP_AWAKE_URL = (os.getenv("KEEP_AWAKE_URL") or os.getenv("RENDER_EXTERNAL_URL") or "").rstrip("/")
KEEP_AWAKE_MINUTES = max(1, int(os.getenv("KEEP_AWAKE_MINUTES", "10")))
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]

TIMEZONE = "Asia/Kolkata"
# Depot / supplier hub used as the start point for route ordering and ETAs.
DEPOT_LAT = float(os.getenv("DEPOT_LAT", "12.9352"))
DEPOT_LNG = float(os.getenv("DEPOT_LNG", "77.6245"))

# Admin accounts: usernames (comma-separated) that share ADMIN_PASSWORD. Applied on every start-up:
# these accounts are created or updated, and nobody else keeps admin access. Admins sign in with
# username + password only (no OTP). Keep the password in your host's secret settings, not in git.
ADMIN_USERS = [u.strip().lower() for u in os.getenv("ADMIN_USERS", "ritissh,kritheesh,subhasree").split(",") if u.strip()]
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "")

# Optional: path to the built frontend (`frontend/dist`). When set, the API also serves the app at /.
FRONTEND_DIST = os.getenv("FRONTEND_DIST", "")

LOCATION_INTERVAL_SECONDS = 10
SIGNAL_LOST_AFTER_SECONDS = 70


def check_production_safety():
    """Refuse to run a non-demo deployment with the placeholder signing secret."""
    if not DEMO_ENV and (JWT_SECRET in ("change-me-in-production", "replace-with-a-long-random-string")
                          or len(JWT_SECRET) < 32):
        raise RuntimeError("Set JWT_SECRET to a long random string (32+ characters) before running with DEMO_MODE=false")


def razorpay_enabled() -> bool:
    return bool(RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET)


def twilio_enabled() -> bool:
    return bool(TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER)
