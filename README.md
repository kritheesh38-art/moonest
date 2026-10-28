# MooNest: hyperlocal milk marketplace

React + TypeScript (Vite) frontend · FastAPI backend (REST + WebSocket) · MongoDB.

Three roles from one login screen:

| Role | URL | What they do |
|---|---|---|
| Customer | `/` | Shop & one-off orders, subscriptions (daily / alternate / custom days), skip, vacation pause, address change, live tracking, wallet, invoices |
| Milk agent | `/agent` (pick **Milk Agent** on login) | Today's ordered route, start trip (GPS every 20 s), mark Delivered (photo) / Skipped / Failed (reason), COD cash tally, end-of-day handoff |
| Admin | `/admin/login` | Generate & assign routes, live fleet map, COD reconciliation, refunds, pause/unpause subs, edit product prices, plans, cutoff & fees, agents, serviceable pincodes |

## Two ways to run

The same React app runs in one of two modes. Both expose the same API (endpoints, bodies and
responses), and the browser suites in this project pass against either.

| | In-browser (published link) | Server (production) |
|---|---|---|
| Backend | `frontend/src/server/*` answers every call inside the page | FastAPI in `backend/` |
| Data | The artifact's shared database, or this browser's storage | MongoDB |
| Sign-in | Session in the browser | JWT bearer token |
| Payments, OTP, SMS | Simulated | Razorpay, Twilio (simulated in demo mode when keys are empty) |
| Live updates | Shared-database push | Screens refresh every 5 s (WebSocket endpoints also available) |
| Build | `npm run build:artifact` → `moonest-app.html` | `npm run build:server` → `dist-server/` |

The product catalogue lives in one file used by both: `frontend/src/server/catalogue.json`, copied to
`backend/app/data/catalogue.json`. A backend test fails if the two copies differ.

## Run the server version locally

```bash
# backend
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env            # MONGO_URL=mongomock:// runs an in-memory DB, no MongoDB needed
.venv/bin/uvicorn app.main:app --port 8001 --reload

# frontend (new terminal)
cd frontend
npm install
npm run dev:server              # http://localhost:3000, proxies /api to :8001
```

On the published claude.ai link the app runs in each visitor's browser, so admin there is hidden
from testers but can't be truly locked. The server version enforces it.

Or as one server: `cd frontend && npm run build:server`, then start the backend with
`FRONTEND_DIST=../frontend/dist-server`, and open http://localhost:8001.

**Admin is private.** Only the usernames in `ADMIN_USERS` (`ritissh`, `kritheesh`, `subhasree`) can use Admin,
with `ADMIN_PASSWORD`, at **Sign in → Admin sign in**. Admin has no OTP, no demo account and no
one-tap button. Every start-up re-applies this, so any other account that somehow got admin loses it.
Keep the password in your host's secret settings (Render asks for it once), never in git.

Demo accounts for testers (when `SEED_DEMO_DATA=true`, password `pass1234`, or one tap on the sign-in screen):

- Agents: `agent@moonest.in`, Ravi (Koramangala / BTM / Bommanahalli), or OTP to `9000000001`; Suresh (HSR / Indiranagar), OTP to `9000000002`
- Customer: `customer@moonest.in` (Aditi, ₹500 in wallet). Anyone can sign up with email + mobile + password, or just an OTP.

**Demo mode switch.** Admins can turn demo mode on or off for everyone at **Admin → Overview → Demo
mode**. The choice is saved and survives restarts; `DEMO_MODE` only sets the starting value. Off means
demo accounts can't sign in, OTP only by SMS, real payments only, and only the delivery areas set up
in Admin. On turns on every test shortcut below.

With demo mode on the OTP is shown on the sign-in screen, payments open the built-in test
checkout when Razorpay keys are empty, and Admin has **Run tomorrow's deliveries today** so the
agent and live-tracking flow can be tried immediately.

## Deploy

```bash
cp backend/.env.example .env    # set DEMO_MODE=false, SEED_DEMO_DATA=false, JWT_SECRET, ADMIN_PASSWORD, keys
docker compose up -d --build    # MongoDB + MooNest on http://localhost:8000
```

The `Dockerfile` builds the app in server mode and serves it from FastAPI, so there's one container
and one origin. Put it behind HTTPS (Caddy, nginx or your host's load balancer): browsers only allow
GPS on secure pages. The server refuses to start with `DEMO_MODE=false` and a placeholder `JWT_SECRET`.

## Tests

- Backend: `cd backend && .venv/bin/python -m pytest -q` (24 tests: full order → route → delivery
  flow, payments, subscriptions, password accounts and lockout, catalogue parity, demo route, photo
  proof, invoices, private admin access).
- Browser: the Playwright suites (sign-up and payments, agent day, packet colours, dairy, live
  tracking demo, two-device live tracking) run against both builds.

## What the requested fixes look like

- **Phone numbers: exactly 10 digits.** There's a fixed `+91` prefix, digits only, max 10, and it must start with 6–9. Pasted `+91 98765-43210` is cleaned up. An inline error shows and the submit button stays disabled until the number is valid. The backend enforces the same rule on every endpoint that takes a phone (`app/utils.py::normalize_phone`).
- **Dynamic greeting.** It uses India time: Good morning (5–12), afternoon (12–17), evening (17–21), night. It adds the first name and refreshes every minute. The subtitle changes with context ("Your milk is on the way, arriving in ~6 min", "paused until 2 Nov", "Next delivery: Wed, 21 Oct, 5:30 AM"). Agents get it too.
- **Ordering works end to end.** Cart → address with a pincode check → date + slot → UPI/Card/Netbanking (Razorpay), Wallet or COD → confirmation with order number → My Orders and order detail with a progress bar, delivery photo, retry payment and cancel (refunded to wallet).
- **Plans.** Daily (−5%), Alternate day (−3%) and Custom days are stored in the database. Admins can edit names, discounts, perks and product prices, and the customer app and subscription prices update immediately.

## Business rules (all configurable in Admin → Products & plans → Settings)

- Skip, pause, address change, plan change and one-off orders for day D close at **22:00 on D-1** (IST).
- Vacation pause: up to **30 days**, no deliveries and no billing, auto-resumes the next day.
- Address change takes effect from the next editable delivery date, after a serviceability re-check.
- After the cutoff a background job builds tomorrow's routes. Stops go to agents by pincode and are ordered nearest-first. Wallet subscriptions are debited at that point, and AutoPay subscriptions are charged. If the wallet is low or AutoPay fails, the day is skipped and the customer gets an SMS and in-app notice.
- COD: the amount is added to the customer's cash due when delivered. The agent records the cash, and admin reconciles each agent's collected cash against the amount they declared at handover.
- Missed delivery (agent marks Failed): **wallet credit** (default) or **redeliver next day**, per the customer's choice in Account.

## Production setup checklist

| Item | Env vars / notes |
|---|---|
| MongoDB | `MONGO_URL`, `DB_NAME` (the compose file runs MongoDB 7 with a volume) |
| Security | `DEMO_MODE=false`, `SEED_DEMO_DATA=false`, `JWT_SECRET` (32+ random characters). Passwords use PBKDF2-SHA256; 5 wrong passwords lock that account's password sign-in for 15 minutes. |
| Agents (no SMS) | Admin → Agents & areas: give each agent an email + password; they sign in on the Milk Agent tab without OTP. Needed when demo mode is off and Twilio isn't set up. |
| Admins | `ADMIN_USERS` (comma-separated usernames) and `ADMIN_PASSWORD`. Only these accounts are admins, re-applied on every start. Add agents in Admin → Agents. |
| Razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`. The app then opens Razorpay Checkout, and the server verifies the signature. Enable **UPI AutoPay / Recurring payments** on your Razorpay account for mandates. |
| Twilio SMS (OTP, delivered, missed) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`. Without them, OTPs can't be delivered in production. |
| Photo storage | Saved to `UPLOAD_DIR` (a Docker volume) and served at `/api/uploads`. Swap `app/services/storage.py::_store` for S3/GCS if you run several servers. |
| API on another domain | Build the app with `VITE_API_URL=https://api.example.com` and set `CORS_ORIGINS` on the server. |
| Multiple API instances | The WebSocket pub/sub is in-process (`app/services/tracking.py`). Polling works across instances; use Redis pub/sub for WebSockets. |
| Maps & live tracking | The server build shows a real street map (OpenStreetMap data, CARTO tiles; `VITE_MAP_TILES` to change) with the driving route from the public OSRM router (`VITE_ROUTER_URL`; empty = straight line). The agent's phone sends GPS every 10 s and the customer's Track screen gets it instantly over a WebSocket (`/api/ws/track/{delivery}`; the token is sent as the first message, never in the URL), with a 5 s refresh as fallback. The claude.ai build draws its own map. For heavy traffic use your own tile and routing servers or a paid provider. |
| Push notifications | Free phone alerts (Web Push), even with the app closed: "Your milk is on the way", "Delivered" with the photo, and every other in-app update. Customers turn them on in Me → Notifications (or the banner on Home). Keys are made automatically and kept in the database; nothing to set up. iPhone: works once MooNest is added to the home screen (iOS 16.4+). `PUSH_ENABLED=false` turns it off. |
| Keep awake | On Render's free plan the server visits its own address (`RENDER_EXTERNAL_URL`, set by Render) every 10 minutes, so it doesn't fall asleep and visitors don't wait. `KEEP_AWAKE=false` turns it off; elsewhere set `KEEP_AWAKE_URL`. |
| Address search | As customers type their apartment, street or area, matching places appear; picking one fills the address and pins it, and they drag the map so the pin sits on their gate. Most precise for India: `GOOGLE_MAPS_API_KEY` (Google Cloud, enable **Places API (New)**) or `OLA_MAPS_API_KEY` (Ola Maps). Without either, it uses free OpenStreetMap search (Photon), which knows fewer Indian apartments. Keys stay on the server. |
| "Use my current location" | Fills street, area and pincode via OpenStreetMap Nominatim (`GEOCODER_URL`; free, about 1 lookup a second). For heavy use, point it at your own Nominatim or set it empty to only pin the location. Browsers allow location on HTTPS pages only. |

## Known limits (not built yet)

- Browser push uses the Notification API while the app is open, plus SMS. True background Web Push (service worker + VAPID) is not set up.
- AutoPay mandate charging and Razorpay Checkout follow Razorpay's APIs but have only been exercised in demo mode here. Test them with real test keys before launch.
- The Docker image hasn't been built yet (no Docker daemon where this was developed). The commands inside it (`npm run build:server`, uvicorn serving `dist-server`) were run and tested outside Docker.
- Spec phase 2 (supplier portal, payouts) is not built. Suppliers are stored as a field on each product.
