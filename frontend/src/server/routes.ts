/** In-browser API: the same endpoints and rules as the FastAPI backend (app/routers/*). */
import { addDays } from '../lib'
import {
  codAddDue, codBalance, codCollect, cutoff, DEFAULT_SETTINGS, fail, fmtDay, generateRoutes, getSettings, handleMissed,
  isIsoDate, LOCATION_INTERVAL_SECONDS, newId, nextCycleDate, normalizePhone, nowIso, pausedOn, planByCode, rupees,
  sequenceStops, serviceable, SLOT_LABEL, todayIst, trackingPayload, unitPrice, upcomingDates, walletBalance,
  walletCredit, walletDebit, notify, istDate, daysBetween, displayName, isDemo, DEMO_ACCOUNT_IDS,
} from './logic'
import { Doc, store } from './store'

export type Ctx = { user: Doc | null; params: string[]; body: any; form?: FormData; query: URLSearchParams }
type Handler = (c: Ctx) => Promise<unknown> | unknown
type Route = { method: string; re: RegExp; role?: 'customer' | 'agent' | 'admin' | 'any'; h: Handler }
const routes: Route[] = []
const add = (method: string, path: string, role: Route['role'], h: Handler) =>
  routes.push({ method, re: new RegExp('^' + path.replace(/:(\w+)/g, '([^/]+)') + '$'), role, h })

const SESSION_KEY = 'moonest_session'
export function getSession(): { uid: string; role: string } | null {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null')
  } catch {
    return memSession
  }
}
let memSession: { uid: string; role: string } | null = null
export function setSession(s: { uid: string; role: string } | null) {
  memSession = s
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s))
    else localStorage.removeItem(SESSION_KEY)
  } catch {
    /* in-memory session only */
  }
}

export async function dispatch(method: string, fullPath: string, body: any, form?: FormData) {
  const url = new URL(fullPath, 'http://x')
  const path = url.pathname
  for (const r of routes) {
    if (r.method !== method) continue
    const m = path.match(r.re)
    if (!m) continue
    let user: Doc | null = null
    if (r.role) {
      const s = getSession()
      user = s ? store.get('users', s.uid) : null
      if (!user || !(user.roles ?? []).includes(s!.role)) fail(401, 'Please log in')
      if (!isDemo() && DEMO_ACCOUNT_IDS.includes(user!.id)) fail(401, 'Demo accounts are switched off')
      user!.role = s!.role
      if (r.role !== 'any' && user!.role !== r.role) fail(403, "You don't have access to this")
    }
    return r.h({ user, params: m.slice(1).map(decodeURIComponent), body: body ?? {}, form, query: url.searchParams })
  }
  fail(404, 'Not found')
}

const req = (v: unknown, msg: string) => (v === undefined || v === null || v === '' ? fail(422, msg) : v)
const int = (v: unknown, lo: number, hi: number, msg: string) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < lo || n > hi) fail(422, msg)
  return n
}
const date = (v: unknown, msg = 'Pick a valid date') => (isIsoDate(v) ? (v as string) : fail(422, msg)) as string
const oneOf = <T extends string>(v: unknown, opts: readonly T[], msg: string) => (opts.includes(v as T) ? (v as T) : fail(422, msg)) as T
const byNewest = (a: Doc, b: Doc) => String(b.created_at).localeCompare(String(a.created_at))
const publicUser = (u: Doc) => Object.fromEntries(['id', 'name', 'username', 'phone', 'email', 'roles', 'role', 'missed_pref', 'pincodes', 'created_at'].map((k) => [k, u[k]]))

// ======================= auth =======================
const otps = new Map<string, { code: string; exp: number; attempts: number; sent: number }>()
function ident(b: any): [string, string] {
  if (b.phone) return ['phone', normalizePhone(b.phone)]
  if (b.email) {
    const e = String(b.email).trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(e)) fail(422, 'Enter a valid email')
    return ['email', e]
  }
  return fail(422, 'Enter your 10-digit mobile number or email')
}

add('POST', '/api/auth/request-otp', undefined, ({ body }) => {
  const [field, value] = ident(body)
  const role = oneOf(body.role ?? 'customer', ['customer', 'agent', 'admin'] as const, 'Invalid role')
  if (role === 'admin') fail(403, 'Admins sign in with username and password')
  if (!isDemo()) fail(503, "OTP sign-in isn't available right now. Sign in with your email and password.")
  if (role !== 'customer' && !store.one('users', (u) => u[field] === value && (u.roles ?? []).includes(role)))
    fail(403, `This number isn't registered as a ${role === 'agent' ? 'milk agent' : 'admin'}. Please contact MooNest support.`)
  const prev = otps.get(value)
  if (prev && Date.now() - prev.sent < 30_000) fail(429, 'Please wait 30 seconds before requesting another OTP')
  const code = String(Math.floor(Math.random() * 1e6)).padStart(6, '0')
  otps.set(value, { code, exp: Date.now() + 5 * 60_000, attempts: 0, sent: Date.now() })
  return { sent: true, channel: field, expires_in: 300, dev_otp: code }
})

add('POST', '/api/auth/verify-otp', undefined, async ({ body }) => {
  const [field, value] = ident(body)
  const role = oneOf(body.role ?? 'customer', ['customer', 'agent', 'admin'] as const, 'Invalid role')
  if (role === 'admin') fail(403, 'Admins sign in with username and password')
  const rec = otps.get(value)
  if (!rec || Date.now() > rec.exp) fail(400, 'OTP expired. Please request a new one.')
  if (rec!.attempts >= 5) fail(429, 'Too many wrong attempts. Please request a new OTP.')
  if (rec!.code !== String(body.code ?? '')) {
    rec!.attempts++
    fail(400, 'Incorrect OTP')
  }
  otps.delete(value)
  let user = store.one('users', (u) => u[field] === value)
  if (user && !isDemo() && DEMO_ACCOUNT_IDS.includes(user.id)) fail(403, 'Demo accounts are switched off')
  if (role !== 'customer' && (!user || !(user.roles ?? []).includes(role))) fail(403, 'Not registered for this role')
  let isNew = false
  const name = String(body.name ?? '').trim().slice(0, 60)
  if (!user) {
    isNew = true
    user = await store.put('users', { id: newId(), name, [field]: value, roles: ['customer'], wallet_paise: 0, missed_pref: 'wallet_credit', created_at: nowIso() })
  } else {
    if (role === 'customer' && !user.roles.includes('customer')) user.roles = [...user.roles, 'customer']
    if (name && !user.name) user.name = name
    user = await store.put('users', user)
  }
  setSession({ uid: user.id, role })
  return { token: 'local-session', user: { ...publicUser(user), role }, is_new: isNew }
})

export async function hashPassword(password: string, salt: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${password}`))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

add('POST', '/api/auth/register', undefined, async ({ body }) => {
  const name = String(body.name ?? '').trim()
  if (name.length < 2) fail(422, 'Enter your full name')
  const email = String(body.email ?? '').trim().toLowerCase()
  if (!/^\S+@\S+\.\S+$/.test(email)) fail(422, 'Enter a valid email')
  const phone = normalizePhone(body.phone)
  const password = String(body.password ?? '')
  if (password.length < 8) fail(422, 'Password must be at least 8 characters')
  const role = oneOf(body.role ?? 'customer', ['customer', 'agent'] as const, 'Invalid role')
  if (role === 'agent' && !isDemo()) fail(403, 'Milk agents are added by MooNest. Please contact support.')
  if (store.one('users', (u) => u.email === email)) fail(409, 'An account with this email already exists. Sign in instead.')
  if (store.one('users', (u) => u.phone === phone)) fail(409, 'This mobile number is already registered. Sign in instead.')
  const salt = newId().slice(0, 16)
  const user = await store.put('users', {
    id: newId(), name: name.slice(0, 60), email, phone, roles: [role], wallet_paise: 0, missed_pref: 'wallet_credit',
    salt, password_hash: await hashPassword(password, salt), ...(role === 'agent' ? { pincodes: [], active: true } : {}), created_at: nowIso(),
  })
  setSession({ uid: user.id, role })
  return { token: 'local-session', user: { ...publicUser(user), role }, is_new: true }
})

add('POST', '/api/auth/login', undefined, async ({ body }) => {
  const id = String(body.identifier ?? '').trim().toLowerCase()
  const role = oneOf(body.role ?? 'customer', ['customer', 'agent', 'admin'] as const, 'Invalid role')
  const byPhone = id.replace(/\D/g, '').slice(-10)
  const looksLikePhone = /^[\d\s+()-]+$/.test(id) && /^[6-9]\d{9}$/.test(byPhone)
  const user = store.one('users', (u) => (id.includes('@') ? u.email === id : looksLikePhone ? u.phone === byPhone : u.username === id))
  if (!user || !user.password_hash || (await hashPassword(String(body.password ?? ''), user.salt)) !== user.password_hash)
    fail(400, 'Email or password is incorrect')
  if (!isDemo() && DEMO_ACCOUNT_IDS.includes(user!.id)) fail(403, 'Demo accounts are switched off')
  if (!(user!.roles ?? []).includes(role)) fail(403, role === 'agent' ? "This account isn't registered as a milk agent" : role === 'admin' ? "This account isn't an admin" : 'Use the Milk Agent tab to sign in')
  setSession({ uid: user!.id, role })
  return { token: 'local-session', user: { ...publicUser(user!), role }, is_new: false }
})

add('GET', '/api/auth/me', 'any', ({ user }) => ({
  ...publicUser(user!), wallet_paise: walletBalance(user!.id), cod_due_paise: codBalance(user!.id), needs_phone: !user!.phone,
}))

add('PATCH', '/api/auth/me', 'any', async ({ user, body }) => {
  const u = store.get('users', user!.id)!
  if (body.name !== undefined) u.name = String(body.name).trim().slice(0, 60) || u.name
  if (body.phone) {
    const p = normalizePhone(body.phone)
    if (store.one('users', (x) => x.phone === p && x.id !== u.id)) fail(409, 'This mobile number is already linked to another account')
    u.phone = p
  }
  if (body.email) {
    const e = String(body.email).trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(e)) fail(422, 'Enter a valid email')
    if (store.one('users', (x) => x.email === e && x.id !== u.id)) fail(409, 'This email is already linked to another account')
    u.email = e
  }
  if (body.missed_pref) u.missed_pref = oneOf(body.missed_pref, ['wallet_credit', 'redeliver'] as const, 'Invalid preference')
  await store.put('users', u)
  return { ...publicUser(u), role: user!.role }
})

// ======================= catalog =======================
add('GET', '/api/config', undefined, () => {
  const s = getSettings()
  return {
    city: s.city, slots: s.slots, skip_cutoff_hour: s.skip_cutoff_hour, max_pause_days: s.max_pause_days,
    delivery_fee_paise: s.delivery_fee_paise, free_delivery_above_paise: s.free_delivery_above_paise,
    next_cycle_date: nextCycleDate(Number(s.skip_cutoff_hour)), server_time: nowIso(),
    // no payment gateway or SMS in this build: online payments and OTP only work as test shortcuts
    payments_mode: isDemo() ? 'demo' : 'disabled', otp_available: isDemo(), geocoding: false,
    razorpay_key_id: null, demo_mode: isDemo(), location_interval_seconds: LOCATION_INTERVAL_SECONDS, data_mode: store.mode,
  }
})
add('GET', '/api/products', undefined, () => store.find('products', (p) => p.active !== false).sort((a, b) => (a.sort ?? 99) - (b.sort ?? 99)))
add('GET', '/api/plans', undefined, () => store.find('plans', (p) => p.active !== false).sort((a, b) => a.sort - b.sort))
add('GET', '/api/serviceability/:pin', undefined, ({ params }) => {
  const area = serviceable(params[0])
  return { pincode: params[0], serviceable: !!area, area }
})

// ======================= addresses =======================
function addressBody(b: any, uid: string) {
  const pincode = String(b.pincode ?? '')
  if (!/^\d{6}$/.test(pincode)) fail(422, 'Enter a 6-digit pincode')
  const line1 = String(b.line1 ?? '').trim()
  if (line1.length < 3) fail(422, 'Enter your flat / house number and building')
  const area = serviceable(pincode) ?? fail(400, `Sorry, we don't deliver to ${pincode} yet.`)
  const out: Doc = {
    id: '', user_id: uid, label: String(b.label || 'Home').slice(0, 30), line1: line1.slice(0, 120), line2: String(b.line2 ?? '').slice(0, 120),
    landmark: String(b.landmark ?? '').slice(0, 80), pincode, area: area.name, is_default: !!b.is_default,
    contact_phone: b.contact_phone ? normalizePhone(b.contact_phone) : null, lat: b.lat ?? null, lng: b.lng ?? null,
  }
  if (out.lat == null || out.lng == null) {
    // Spread homes around the area centre so routes and maps look realistic
    out.lat = area.lat + (Math.random() - 0.5) * 0.012
    out.lng = area.lng + (Math.random() - 0.5) * 0.012
    out.approx_location = true
  }
  return out
}
add('GET', '/api/addresses', 'customer', ({ user }) => store.find('addresses', (a) => a.user_id === user!.id && !a.deleted))
add('POST', '/api/addresses', 'customer', async ({ user, body }) => {
  const a: Doc = { ...addressBody(body, user!.id), id: newId(), created_at: nowIso() }
  const mine = store.find('addresses', (x) => x.user_id === user!.id && !x.deleted)
  if (a.is_default || !mine.length) {
    for (const x of mine.filter((x) => x.is_default)) await store.put('addresses', { ...x, is_default: false })
    a.is_default = true
  }
  return store.put('addresses', a)
})
add('PUT', '/api/addresses/:id', 'customer', async ({ user, params, body }) => {
  const cur = store.one('addresses', (a) => a.id === params[0] && a.user_id === user!.id) ?? fail(404, 'Address not found')
  const a: Doc = { ...cur, ...addressBody({ ...body, lat: body.lat ?? cur.lat, lng: body.lng ?? cur.lng }, user!.id), id: cur.id }
  if (a.is_default) for (const x of store.find('addresses', (x) => x.user_id === user!.id && x.is_default && x.id !== a.id)) await store.put('addresses', { ...x, is_default: false })
  return store.put('addresses', a)
})
add('DELETE', '/api/addresses/:id', 'customer', async ({ user, params }) => {
  if (store.one('subscriptions', (s) => s.user_id === user!.id && ['active', 'pending_mandate'].includes(s.status) && (s.address_id === params[0] || s.pending_address_id === params[0])))
    fail(400, 'This address is used by an active subscription. Change the subscription address first.')
  await store.patch('addresses', params[0], { deleted: true })
  return { ok: true }
})
function ownedAddress(id: string, uid: string) {
  const a = store.one('addresses', (a) => a.id === id && a.user_id === uid && !a.deleted) ?? fail(400, 'Please choose a delivery address')
  if (!serviceable(a.pincode)) fail(400, `Sorry, we don't deliver to ${a.pincode} anymore.`)
  return a
}

// ======================= orders & payments =======================
function priceCart(items: any) {
  if (!Array.isArray(items) || !items.length) fail(422, 'Your cart is empty')
  let subtotal = 0
  const lines = items.map((it: any) => {
    const p = store.one('products', (p) => p.id === it.product_id && p.active !== false) ?? fail(400, 'One of the products in your cart is no longer available')
    const qty = int(it.qty, 1, 20, 'Quantity must be between 1 and 20')
    subtotal += p.price_paise * qty
    return { product_id: p.id, name: displayName(p), unit: p.unit, image: p.image, qty, price_paise: p.price_paise, line_total_paise: p.price_paise * qty }
  })
  return { lines, subtotal }
}
const orderNumber = () => 'MN' + istDate().slice(2).replace(/-/g, '') + newId().slice(0, 4).toUpperCase()

async function orderConfirmedNotice(o: Doc) {
  const when = new Date(o.delivery_date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })
  await notify(o.user_id, 'Order confirmed', `Order ${o.number} (${rupees(o.total_paise)}) will arrive ${when}, ${SLOT_LABEL[o.slot]}.`, 'order', o.id, '', true)
}
async function newPayment(uid: string, purpose: string, ref: string, amount: number) {
  if (!isDemo()) fail(503, 'Online payments are not configured yet. Please choose Wallet or Cash on Delivery.')
  return store.put('payments', { id: newId(), user_id: uid, purpose, ref, amount_paise: amount, razorpay_order_id: 'order_demo_' + newId().slice(0, 10), status: 'created', demo: true, created_at: nowIso() })
}
const intent = (p: Doc, extra: Record<string, unknown> = {}) => ({ payment_id: p.id, razorpay_order_id: p.razorpay_order_id, amount_paise: p.amount_paise, demo: true, ...extra })

add('POST', '/api/orders', 'customer', async ({ user, body }) => {
  const s = getSettings()
  const d = date(body.delivery_date)
  const slot = oneOf(body.slot, ['morning', 'evening'] as const, 'Pick a delivery slot')
  const method = oneOf(body.payment_method, ['razorpay', 'wallet', 'cod'] as const, 'Pick a payment method')
  const earliest = nextCycleDate(Number(s.skip_cutoff_hour))
  if (d < earliest) fail(400, `Earliest delivery date is ${fmtDay(earliest)} (orders close at ${s.skip_cutoff_hour}:00 the night before)`)
  if (d > addDays(todayIst(), 30)) fail(400, 'You can order up to 30 days ahead')
  const addr = ownedAddress(body.address_id, user!.id)
  if (!(addr.contact_phone || user!.phone)) fail(400, 'Add a 10-digit mobile number so the milk agent can reach you')
  const { lines, subtotal } = priceCart(body.items)
  const fee = subtotal >= s.free_delivery_above_paise ? 0 : s.delivery_fee_paise
  const total = subtotal + fee
  const order: Doc = {
    id: newId(), number: orderNumber(), user_id: user!.id, items: lines, subtotal_paise: subtotal, delivery_fee_paise: fee,
    total_paise: total, address: addr, slot, delivery_date: d, payment_method: method, note: String(body.note ?? '').slice(0, 200),
    created_at: nowIso(), status: 'pending', payment_status: 'pending',
  }
  const resp: Doc = { id: '' }
  if (method === 'cod') Object.assign(order, { status: 'confirmed', payment_status: 'cod_pending' })
  else if (method === 'wallet') {
    if (!(await walletDebit(user!.id, total, 'order_payment', order.id, `Order ${order.number}`)))
      fail(402, `Wallet balance ${rupees(walletBalance(user!.id))} is less than ${rupees(total)}. Top up or choose another method.`)
    Object.assign(order, { status: 'confirmed', payment_status: 'paid' })
  } else {
    const p = await newPayment(user!.id, 'order', order.id, total)
    order.razorpay_order_id = p.razorpay_order_id
    resp.payment = intent(p)
  }
  await store.put('orders', order)
  if (order.status === 'confirmed') await orderConfirmedNotice(order)
  return { order, payment: resp.payment }
})

add('POST', '/api/payments/verify', 'customer', async ({ user, body }) => {
  const pay = store.one('payments', (p) => p.id === body.payment_id && p.user_id === user!.id) ?? fail(404, 'Payment not found')
  if (pay.status === 'paid') return { status: 'paid', already: true }
  if (!isDemo()) fail(400, 'Test payments are switched off')
  if (body.demo_outcome !== 'success') {
    await store.put('payments', { ...pay, status: 'failed' })
    if (pay.purpose === 'order') await store.patch('orders', pay.ref, { payment_status: 'failed' })
    return { status: 'failed', message: 'Payment failed or was cancelled. You can retry or pick another method.' }
  }
  const rzp = 'pay_demo_' + pay.id.slice(0, 10)
  await store.put('payments', { ...pay, status: 'paid', razorpay_payment_id: rzp, method: String(body.method ?? ''), method_detail: String(body.method_detail ?? '').slice(0, 60), paid_at: nowIso() })
  if (pay.purpose === 'order') {
    const cur = store.get('orders', pay.ref)
    if (cur?.status === 'cancelled') {
      // cancelled while paying: give the money back
      await walletCredit(user!.id, pay.amount_paise, 'refund', cur.id, `Refund for cancelled order ${cur.number}`)
      await store.patch('orders', cur.id, { payment_status: 'refunded_to_wallet' })
      return { status: 'paid', refunded_to_wallet: true }
    }
    const upd: Record<string, unknown> = { status: 'confirmed', payment_status: 'paid', razorpay_payment_id: rzp }
    if (cur) {
      // Paid after that day's orders closed or its route was built: move to the next open day
      let day = cur.delivery_date > nextCycleDate(cutoff()) ? cur.delivery_date : nextCycleDate(cutoff())
      while (store.get('route_runs', day)) day = addDays(day, 1)
      if (day !== cur.delivery_date) Object.assign(upd, { delivery_date: day, rescheduled: true })
    }
    const o = await store.patch('orders', pay.ref, upd)
    if (o) await orderConfirmedNotice(o)
  } else if (pay.purpose === 'topup') await walletCredit(user!.id, pay.amount_paise, 'topup', pay.id, 'Wallet top-up')
  else if (pay.purpose === 'mandate') {
    const sub = store.get('subscriptions', pay.ref)!
    await store.put('subscriptions', { ...sub, status: 'active', mandate: { ...sub.mandate, status: 'active', token_id: 'token_demo_' + pay.id.slice(0, 10), activated_at: nowIso() } })
    await notify(user!.id, 'UPI AutoPay active', 'Your subscription is live. Deliveries will be auto-debited.', 'subscription', pay.ref)
  }
  return { status: 'paid' }
})

add('POST', '/api/orders/:id/retry-payment', 'customer', async ({ user, params }) => {
  const o = store.one('orders', (o) => o.id === params[0] && o.user_id === user!.id)
  if (!o || o.status !== 'pending' || o.payment_method !== 'razorpay') fail(400, "This order doesn't need payment")
  const p = await newPayment(user!.id, 'order', o!.id, o!.total_paise)
  await store.put('orders', { ...o!, razorpay_order_id: p.razorpay_order_id, payment_status: 'pending' })
  return intent(p)
})
add('GET', '/api/orders', 'customer', ({ user }) => store.find('orders', (o) => o.user_id === user!.id).sort(byNewest))
function orderDetail(id: string, uid: string) {
  const o = store.one('orders', (o) => o.id === id && o.user_id === uid) ?? fail(404, 'Order not found')
  const dl = store.get('deliveries', o.delivery_id)
  if (dl) o.delivery = { status: dl.status, photo_url: dl.photo_url, delivered_at: dl.delivered_at, failure_reason: dl.failure_reason }
  o.can_cancel = ['pending', 'confirmed'].includes(o.status) && !o.delivery_id && o.delivery_date >= nextCycleDate(cutoff())
  return o
}
add('GET', '/api/orders/:id', 'customer', ({ user, params }) => orderDetail(params[0], user!.id))
add('POST', '/api/orders/:id/cancel', 'customer', async ({ user, params }) => {
  const o = orderDetail(params[0], user!.id)
  if (!o.can_cancel) fail(400, 'This order can no longer be cancelled')
  const upd: Doc = { ...store.get('orders', o.id)!, status: 'cancelled', cancelled_at: nowIso() }
  if (o.payment_status === 'paid') {
    await walletCredit(user!.id, o.total_paise, 'refund', o.id, `Refund for order ${o.number}`)
    upd.payment_status = 'refunded_to_wallet'
  }
  await store.put('orders', upd)
  await notify(user!.id, 'Order cancelled', `Order ${o.number} was cancelled.` + (o.payment_status === 'paid' ? ' Amount refunded to your wallet.' : ''), 'order', o.id)
  return orderDetail(o.id, user!.id)
})

// ======================= wallet / invoices / notifications =======================
add('GET', '/api/wallet', 'customer', ({ user }) => ({
  balance_paise: walletBalance(user!.id), cod_due_paise: codBalance(user!.id),
  ledger: store.find('wallet_ledger', (e) => e.user_id === user!.id).sort(byNewest).slice(0, 200),
  cod_ledger: store.find('cod_ledger', (e) => e.user_id === user!.id).sort(byNewest).slice(0, 100),
  payments: store.find('payments', (p) => p.user_id === user!.id).sort(byNewest).slice(0, 100),
}))
add('POST', '/api/wallet/topup', 'customer', async ({ user, body }) => {
  const amt = int(body.amount_paise, 10000, 2000000, 'Top up between ₹100 and ₹20,000')
  return intent(await newPayment(user!.id, 'topup', '', amt))
})
add('GET', '/api/invoices', 'customer', ({ user }) => {
  const months = new Map<string, Doc>()
  for (const d of store.find('deliveries', (d) => d.user_id === user!.id && d.status === 'delivered')) {
    const m = d.date.slice(0, 7)
    const inv = months.get(m) ?? { id: m, month: m, deliveries: 0, amount_paise: 0 }
    inv.deliveries++
    inv.amount_paise += d.amount_paise
    months.set(m, inv)
  }
  return [...months.values()].sort((a, b) => b.month.localeCompare(a.month))
})
add('GET', '/api/invoices/:month', 'customer', ({ user, params }) => {
  const rows = store.find('deliveries', (d) => d.user_id === user!.id && d.status === 'delivered' && d.date.startsWith(params[0])).sort((a, b) => a.date.localeCompare(b.date))
  if (!rows.length) fail(404, 'No deliveries in this month')
  return {
    month: params[0], customer: { name: user!.name, phone: user!.phone },
    lines: rows.flatMap((d) => {
      const items = d.items.map((i: Doc) => ({ date: d.date, slot: SLOT_LABEL[d.slot], name: i.name, unit: i.unit, qty: i.qty, rate_paise: i.price_paise, amount_paise: i.price_paise * i.qty, paid_via: d.payment_method }))
      const fee = d.amount_paise - items.reduce((s: number, x: Doc) => s + x.amount_paise, 0) // one-off orders below free delivery
      return fee > 0 ? [...items, { date: d.date, slot: SLOT_LABEL[d.slot], name: 'Delivery fee', unit: '', qty: 1, rate_paise: fee, amount_paise: fee, paid_via: d.payment_method }] : items
    }),
    total_paise: rows.reduce((s, d) => s + d.amount_paise, 0),
  }
})
add('GET', '/api/notifications', 'any', ({ user }) => store.find('notifications', (n) => n.user_id === user!.id).sort(byNewest).slice(0, 50))
add('POST', '/api/notifications/read', 'any', async ({ user }) => {
  for (const n of store.find('notifications', (n) => n.user_id === user!.id && !n.read)) await store.put('notifications', { ...n, read: true })
  return { ok: true }
})
add('GET', '/api/tracking/today', 'customer', ({ user }) =>
  store.find('deliveries', (d) => d.user_id === user!.id && d.date === todayIst()).sort((a, b) => a.slot.localeCompare(b.slot)).map(trackingPayload))

// ======================= subscriptions =======================
function subView(sub: Doc) {
  const product = store.get('products', sub.product_id) ?? ({} as Doc)
  const plan = store.one('plans', (p) => p.code === sub.plan_code) ?? ({} as Doc)
  const price = product.price_paise ? unitPrice(product, plan) : 0
  const start = sub.start_date > todayIst() ? sub.start_date : todayIst()
  const monthCount = upcomingDates(sub, start, 30).filter((x) => x.state === 'scheduled').length
  return {
    ...sub, product, plan, address: store.get('addresses', sub.address_id), pending_address: store.get('addresses', sub.pending_address_id),
    unit_price_paise: price, per_delivery_paise: price * sub.quantity, est_monthly_paise: price * sub.quantity * monthCount,
    upcoming: upcomingDates(sub, start, 14), display_status: sub.status === 'active' && pausedOn(sub, todayIst()) ? 'paused' : sub.status,
    slot_label: SLOT_LABEL[sub.slot], next_editable_date: nextCycleDate(cutoff()), cutoff_hour: cutoff(),
  }
}
const ownSub = (id: string, uid: string) => store.one('subscriptions', (s) => s.id === id && s.user_id === uid) ?? fail(404, 'Subscription not found')
const days = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()

add('GET', '/api/subscriptions', 'customer', ({ user }) => store.find('subscriptions', (s) => s.user_id === user!.id).sort(byNewest).map(subView))
add('GET', '/api/subscriptions/:id', 'customer', ({ user, params }) => subView(ownSub(params[0], user!.id)))
add('POST', '/api/subscriptions', 'customer', async ({ user, body }) => {
  const plan_code = oneOf(body.plan_code, ['daily', 'alternate', 'custom'] as const, 'Pick a plan')
  const custom_days = days(body.custom_days)
  if (plan_code === 'custom' && !custom_days.length) fail(422, 'Pick at least one delivery day for a custom plan')
  const plan = planByCode(plan_code)
  const product = store.one('products', (p) => p.id === body.product_id && p.active !== false)
  if (!product || product.subscribable === false) fail(400, "This product isn't available for subscription")
  const quantity = int(body.quantity, 1, 10, 'Quantity must be between 1 and 10')
  const slot = oneOf(body.slot, ['morning', 'evening'] as const, 'Pick a slot')
  const method = oneOf(body.payment_method, ['autopay', 'wallet', 'cod'] as const, 'Pick a payment method')
  const addr = store.one('addresses', (a) => a.id === body.address_id && a.user_id === user!.id && !a.deleted)
  if (!addr || !serviceable(addr.pincode)) fail(400, 'Please choose a serviceable delivery address')
  if (!(addr!.contact_phone || user!.phone)) fail(400, 'Add a 10-digit mobile number so the milk agent can reach you')
  const start = date(body.start_date)
  const earliest = nextCycleDate(cutoff())
  if (start < earliest) fail(400, `Earliest start date is ${fmtDay(earliest)}`)
  const per = unitPrice(product!, plan) * quantity
  if (method === 'wallet' && walletBalance(user!.id) < per) fail(402, `Top up at least ${rupees(per)} to start a wallet subscription`)
  const sub: Doc = { id: newId(), user_id: user!.id, product_id: product!.id, quantity, plan_code, custom_days, slot, start_date: start, address_id: addr!.id, payment_method: method, skips: [], pauses: [], status: 'active', created_at: nowIso() }
  let payment
  if (method === 'autopay') {
    if (!user!.phone) fail(400, 'UPI AutoPay needs a 10-digit mobile number on your profile')
    const max = Math.max(per * 2, 50000)
    if (!isDemo()) fail(503, 'Online payments are not configured yet. Please choose Wallet or Cash on Delivery.')
    sub.status = 'pending_mandate'
    sub.mandate = { status: 'pending', customer_id: 'cust_demo_' + user!.phone, max_amount_paise: max }
    const p = await store.put('payments', { id: newId(), user_id: user!.id, purpose: 'mandate', ref: sub.id, amount_paise: 100, razorpay_order_id: 'order_demo_mandate', status: 'created', demo: true, created_at: nowIso() })
    payment = intent(p, { recurring: true, customer_id: sub.mandate.customer_id })
  }
  await store.put('subscriptions', sub)
  if (sub.status === 'active')
    await notify(user!.id, 'Subscription started', `${product!.name} × ${quantity}, ${plan.name}, from ${fmtDay(start)} at ${SLOT_LABEL[slot]}.`, 'subscription', sub.id, '', true)
  return { subscription: subView(sub), payment }
})
add('PATCH', '/api/subscriptions/:id', 'customer', async ({ user, params, body }) => {
  const sub = ownSub(params[0], user!.id)
  if (sub.status === 'cancelled') fail(400, 'This subscription is cancelled')
  const upd: Doc = { ...sub }
  if (body.quantity != null) upd.quantity = int(body.quantity, 1, 10, 'Quantity must be between 1 and 10')
  if (body.plan_code != null) upd.plan_code = planByCode(body.plan_code).code
  if (body.custom_days != null) upd.custom_days = days(body.custom_days)
  if (body.slot != null) upd.slot = oneOf(body.slot, ['morning', 'evening'] as const, 'Pick a slot')
  if (body.payment_method != null) upd.payment_method = oneOf(body.payment_method, ['autopay', 'wallet', 'cod'] as const, 'Pick a payment method')
  if (upd.plan_code === 'custom' && !upd.custom_days?.length) fail(422, 'Pick at least one delivery day for a custom plan')
  if (upd.plan_code === 'alternate' && sub.plan_code !== 'alternate') {
    const n = nextCycleDate(cutoff())
    upd.start_date = sub.start_date > n ? sub.start_date : n // never earlier than the customer chose
  }
  if (upd.payment_method === 'autopay' && sub.payment_method !== 'autopay' && sub.mandate?.status !== 'active')
    fail(400, 'Set up UPI AutoPay by creating a new subscription with AutoPay, or use Wallet/COD')
  if (sub.status === 'pending_mandate' && ['wallet', 'cod'].includes(upd.payment_method)) {
    upd.status = 'active'
    const n = nextCycleDate(cutoff())
    upd.start_date = sub.start_date > n ? sub.start_date : n
  }
  return subView(await store.put('subscriptions', upd))
})
add('POST', '/api/subscriptions/:id/skip', 'customer', async ({ user, params, body }) => {
  const sub = ownSub(params[0], user!.id)
  const d = date(body.date)
  if (d < nextCycleDate(cutoff())) fail(400, `Changes for ${fmtDay(d)} closed at ${cutoff()}:00 the night before`)
  const skips = new Set<string>(sub.skips ?? [])
  if (body.skip === false) skips.delete(d)
  else skips.add(d)
  const saved = await store.put('subscriptions', { ...sub, skips: [...skips] })
  if (body.skip !== false) {
    // The stop may already be built (e.g. the admin generated that day early): remove it and refund
    for (const s of store.find('deliveries', (x) => x.kind === 'subscription' && x.ref_id === sub.id && x.status === 'pending' && (x.date === d || x.for_date === d))) {
      await store.remove('deliveries', s.id)
      if (s.payment_status === 'paid') await walletCredit(user!.id, s.amount_paise, 'skipped_delivery_credit', s.id, `Skipped delivery on ${fmtDay(d)}`)
    }
  }
  return subView(saved)
})
add('POST', '/api/subscriptions/:id/pause', 'customer', async ({ user, params, body }) => {
  const sub = ownSub(params[0], user!.id)
  const s = getSettings()
  const start = date(body.start_date), end = date(body.end_date)
  if (end < start) fail(422, 'End date must be on or after start date')
  if (daysBetween(start, end) + 1 > s.max_pause_days) fail(422, `Vacation pause can be at most ${s.max_pause_days} days`)
  const n = nextCycleDate(Number(s.skip_cutoff_hour))
  if (start < n) fail(400, `Pause can start from ${fmtDay(n)}`)
  if ((sub.pauses ?? []).some((p: Doc) => !(end < p.start_date || start > p.end_date))) fail(400, 'This overlaps an existing pause')
  const pauses = [...(sub.pauses ?? []), { id: newId(), start_date: start, end_date: end, created_at: nowIso() }]
  await notify(user!.id, 'Vacation pause set', `Deliveries and billing paused ${fmtDay(start)} – ${fmtDay(end)}. Auto-resumes ${fmtDay(addDays(end, 1))}.`, 'subscription', sub.id)
  return subView(await store.put('subscriptions', { ...sub, pauses }))
})
add('DELETE', '/api/subscriptions/:id/pause/:pid', 'customer', async ({ user, params }) => {
  const sub = ownSub(params[0], user!.id)
  const n = nextCycleDate(cutoff())
  const p = (sub.pauses ?? []).find((p: Doc) => p.id === params[1]) ?? fail(404, 'Pause not found')
  if (p.end_date < n) fail(400, 'This pause has already ended')
  const pauses = p.start_date >= n
    ? sub.pauses.filter((x: Doc) => x.id !== p.id)
    : sub.pauses.map((x: Doc) => (x.id === p.id ? { ...x, end_date: addDays(n, -1) } : x))
  return subView(await store.put('subscriptions', { ...sub, pauses }))
})
add('POST', '/api/subscriptions/:id/address', 'customer', async ({ user, params, body }) => {
  const sub = ownSub(params[0], user!.id)
  const addr = store.one('addresses', (a) => a.id === body.address_id && a.user_id === user!.id && !a.deleted) ?? fail(404, 'Address not found')
  if (!serviceable(addr.pincode)) fail(400, `Sorry, we don't deliver to ${addr.pincode} yet. Your current address stays active.`)
  if (!(addr.contact_phone || user!.phone)) fail(400, 'Add a 10-digit mobile number so the milk agent can reach you')
  if (addr.id === sub.address_id) {
    const { pending_address_id: _a, pending_effective_date: _b, ...rest } = sub
    return subView(await store.put('subscriptions', rest as Doc))
  }
  const eff = nextCycleDate(cutoff())
  await notify(user!.id, 'Address change scheduled', `Deliveries move to '${addr.label}' from ${fmtDay(eff)}.`, 'subscription', sub.id)
  return subView(await store.put('subscriptions', { ...sub, pending_address_id: addr.id, pending_effective_date: eff }))
})
add('POST', '/api/subscriptions/:id/cancel', 'customer', async ({ user, params }) => {
  const sub = ownSub(params[0], user!.id)
  await notify(user!.id, 'Subscription cancelled', 'Your subscription has been cancelled. Already-scheduled deliveries for the next cycle may still arrive.', 'subscription', sub.id)
  return subView(await store.put('subscriptions', { ...sub, status: 'cancelled', cancelled_at: nowIso() }))
})
add('POST', '/api/subscriptions/:id/resume', 'customer', async ({ user, params }) => {
  const sub = ownSub(params[0], user!.id)
  if (sub.status !== 'cancelled') fail(400, 'Subscription is already active')
  if (sub.payment_method === 'autopay' && sub.mandate?.status !== 'active') fail(400, 'AutoPay mandate is not active. Switch to Wallet or COD first.')
  const n = nextCycleDate(cutoff())
  return subView(await store.put('subscriptions', { ...sub, status: 'active', start_date: sub.start_date > n ? sub.start_date : n }))
})
add('POST', '/api/subscriptions/:id/mandate', 'customer', async ({ user, params }) => {
  const sub = ownSub(params[0], user!.id)
  if (sub.status !== 'pending_mandate') fail(400, 'AutoPay is already set up for this subscription')
  if (!isDemo()) fail(503, 'Online payments are not configured yet. Please choose Wallet or Cash on Delivery.')
  const p = await store.put('payments', { id: newId(), user_id: user!.id, purpose: 'mandate', ref: sub.id, amount_paise: 100, razorpay_order_id: 'order_demo_mandate', status: 'created', demo: true, created_at: nowIso() })
  return intent(p, { recurring: true, customer_id: sub.mandate.customer_id })
})

// ======================= agent =======================
const FAIL_TEXT: Record<string, string> = {
  customer_unavailable: 'customer unavailable', address_not_found: 'address not found', gate_locked: 'gate locked',
  refused: 'delivery refused', out_of_stock: 'item out of stock', other: 'other reason',
}
async function ensureTodayRoutes() {
  const t = todayIst()
  if (!store.get('route_runs', t)) {
    const res = await generateRoutes(t) // recorded only after it worked, so a failure is retried
    await store.put('route_runs', { id: t, date: t, at: nowIso(), by: 'on_demand', status: 'done', result: res })
  }
}
/** Today's running trip. One left open on an earlier day doesn't count (it's closed when the agent loads today). */
const activeTrip = (aid: string) => store.one('trips', (t) => t.agent_id === aid && t.status === 'active' && t.date === todayIst())
async function closeOldTrips(aid: string) {
  for (const t of store.find('trips', (t) => t.agent_id === aid && t.status === 'active' && t.date < todayIst()))
    await store.put('trips', { ...t, status: 'ended', ended_at: nowIso(), auto_ended: true })
}
function tally(aid: string, d: string) {
  const counts: Record<string, number> = { pending: 0, delivered: 0, skipped: 0, failed: 0 }
  for (const x of store.find('deliveries', (x) => x.agent_id === aid && x.date === d)) counts[x.status]++
  const cash = store.find('cod_ledger', (e) => e.agent_id === aid && e.type === 'collected' && e.date === d).reduce((s, e) => s + e.amount_paise, 0)
  return { cash_collected_paise: cash, ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) }
}
const stopOf = (id: string, aid: string) => store.one('deliveries', (d) => d.id === id && d.agent_id === aid) ?? fail(404, 'Stop not found on your route')
const pendingOnly = (d: Doc) => d.status !== 'pending' && fail(400, `This stop is already marked ${d.status}`)

add('GET', '/api/agent/today', 'agent', async ({ user, query }) => {
  await ensureTodayRoutes()
  await closeOldTrips(user!.id)
  const slot = query.get('slot')
  const stops = store.find('deliveries', (d) => d.agent_id === user!.id && d.date === todayIst() && (!slot || d.slot === slot))
    .sort((a, b) => a.slot.localeCompare(b.slot) || a.sequence - b.sequence)
    .map((d) => ({ ...d, cod_due_paise: d.payment_method === 'cod' ? codBalance(d.user_id) : 0 }))
  return { date: todayIst(), agent: { id: user!.id, name: user!.name }, trip: activeTrip(user!.id), stops, tally: tally(user!.id, todayIst()) }
})
add('POST', '/api/agent/trips/start', 'agent', async ({ user, body }) => {
  if (activeTrip(user!.id)) fail(400, 'A trip is already in progress')
  const slot = oneOf(body.slot, ['morning', 'evening'] as const, 'Pick a slot')
  const trip = await store.put('trips', { id: newId(), agent_id: user!.id, date: todayIst(), slot, status: 'active', started_at: nowIso(), last_location: null })
  const seen = new Set<string>()
  for (const d of store.find('deliveries', (d) => d.agent_id === user!.id && d.date === todayIst() && d.slot === slot && d.status === 'pending')) {
    if (seen.has(d.user_id)) continue
    seen.add(d.user_id)
    await notify(d.user_id, 'Your milk is on the way', `${user!.name || 'Your milk agent'} has started the ${SLOT_LABEL[slot]} route. Track live in the app.`, 'tracking', d.id)
  }
  return trip
})
add('POST', '/api/agent/location', 'agent', async ({ user, body }) => {
  const trip = activeTrip(user!.id) ?? fail(409, 'Start a trip to share location')
  const lat = Number(body.lat), lng = Number(body.lng)
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) fail(422, 'Invalid location')
  await store.put('trips', { ...trip, last_location: { lat, lng, accuracy: body.accuracy ?? null, simulated: !!body.simulated, ts: nowIso() } })
  return { ok: true }
})
add('POST', '/api/agent/deliveries/:id/delivered', 'agent', async ({ user, params, form }) => {
  const d = stopOf(params[0], user!.id)
  pendingOnly(d)
  const trip = activeTrip(user!.id)
  await store.put('deliveries', { ...d, status: 'delivered', delivered_at: nowIso(), delivered_location: trip?.last_location ?? null, trip_id: trip?.id ?? null })
  if (d.payment_status === 'cod_pending') await codAddDue(d.user_id, d.amount_paise, d.id, d.items.map((i: Doc) => `${i.name} × ${i.qty}`).join(', '))
  if (d.kind === 'order') await store.patch('orders', d.ref_id, { status: 'delivered', delivered_at: nowIso() })
  else if (d.kind === 'redelivery') {
    const orig = store.get('deliveries', d.original_delivery_id)
    if (orig?.kind === 'order') await store.patch('orders', orig.ref_id, { status: 'delivered', delivered_at: nowIso() })
  }
  const cash = Math.min(Number(form?.get('cash_paise') ?? 0) || 0, codBalance(d.user_id)) // never more than is owed
  if (cash > 0) await collect(store.get('deliveries', d.id)!, user!, cash)
  await notify(d.user_id, 'Delivered', `Your ${SLOT_LABEL[d.slot]} delivery (${d.items.map((i: Doc) => i.name).join(', ')}) was delivered.`, 'delivered', d.id, '', true)
  return store.get('deliveries', d.id)
})
async function collect(d: Doc, agent: Doc, amount: number) {
  await codCollect(d.user_id, agent.id, amount, d.id, activeTrip(agent.id)?.id ?? '', d.date)
  await store.patch('deliveries', d.id, { cod_collected_paise: (d.cod_collected_paise ?? 0) + amount })
  await notify(d.user_id, 'Cash received', `${rupees(amount)} received in cash by ${agent.name || 'your milk agent'}.`, 'payment', d.id)
}
add('POST', '/api/agent/deliveries/:id/cash', 'agent', async ({ user, params, body }) => {
  const d = stopOf(params[0], user!.id)
  const amount = int(body.amount_paise, 1, 10_000_000, 'Enter the cash amount')
  const due = codBalance(d.user_id)
  if (amount > due) fail(400, due > 0 ? `Only ${rupees(due)} is due from this customer` : 'Nothing is due from this customer')
  await collect(d, user!, amount)
  return { cod_due_paise: codBalance(d.user_id), tally: tally(user!.id, todayIst()) }
})
add('POST', '/api/agent/deliveries/:id/skipped', 'agent', async ({ user, params }) => {
  const d = stopOf(params[0], user!.id)
  pendingOnly(d)
  await store.put('deliveries', { ...d, status: 'skipped', skipped_at: nowIso() })
  const paid = d.payment_status === 'paid'
  if (paid) await walletCredit(d.user_id, d.amount_paise, 'skipped_delivery_credit', d.id, `Skipped delivery on ${fmtDay(d.date)}`)
  if (d.kind === 'order') await store.patch('orders', d.ref_id, { status: 'cancelled', ...(paid ? { payment_status: 'refunded_to_wallet' } : {}) })
  await notify(d.user_id, 'Delivery skipped', "Today's delivery was skipped at your request." + (paid ? ` ${rupees(d.amount_paise)} credited to your wallet.` : ''), 'warning', d.id)
  return store.get('deliveries', d.id)
})
add('POST', '/api/agent/deliveries/:id/failed', 'agent', async ({ user, params, body }) => {
  const d = stopOf(params[0], user!.id)
  pendingOnly(d)
  const reason = oneOf(body.reason, Object.keys(FAIL_TEXT), 'Pick a reason')
  const text = FAIL_TEXT[reason] + (body.note ? `: ${String(body.note).slice(0, 200)}` : '')
  await store.put('deliveries', { ...d, status: 'failed', failure_reason: text, failed_at: nowIso() })
  const outcome = await handleMissed(d, FAIL_TEXT[reason])
  return store.patch('deliveries', d.id, { missed_outcome: outcome })
})
add('POST', '/api/agent/trips/end', 'agent', async ({ user, body }) => {
  const trip = activeTrip(user!.id) ?? fail(400, 'No trip in progress')
  const left = store.find('deliveries', (d) => d.agent_id === user!.id && d.date === trip.date && d.slot === trip.slot && d.status === 'pending').length
  return store.put('trips', {
    ...trip, status: 'ended', ended_at: nowIso(), summary: tally(user!.id, trip.date), pending_left: left,
    handoff_note: String(body.handoff_note ?? '').slice(0, 300), cash_handed_over_paise: Math.max(0, Number(body.cash_handed_over_paise) || 0),
  })
})
add('GET', '/api/agent/summary', 'agent', ({ user }) => ({
  date: todayIst(), tally: tally(user!.id, todayIst()),
  trips: store.find('trips', (t) => t.agent_id === user!.id && t.date === todayIst()).sort((a, b) => a.started_at.localeCompare(b.started_at)),
  collections: store.find('cod_ledger', (e) => e.agent_id === user!.id && e.type === 'collected' && e.date === todayIst()),
}))

// ======================= admin =======================
add('GET', '/api/admin/overview', 'admin', ({ query }) => {
  const d = query.get('date') || todayIst()
  const counts: Record<string, number> = { pending: 0, delivered: 0, skipped: 0, failed: 0 }
  let value = 0
  for (const x of store.find('deliveries', (x) => x.date === d)) {
    counts[x.status]++
    if (x.status === 'delivered') value += x.amount_paise
  }
  return {
    date: d, deliveries: counts, unassigned: store.find('deliveries', (x) => x.date === d && !x.agent_id).length, delivered_value_paise: value,
    active_subscriptions: store.find('subscriptions', (s) => s.status === 'active').length,
    customers: store.find('users', (u) => u.roles?.includes('customer')).length, agents: store.find('users', (u) => u.roles?.includes('agent')).length,
    active_trips: store.find('trips', (t) => t.status === 'active' && t.date === todayIst()).length,
    orders_today: store.find('orders', (o) => istDate(o.created_at) === todayIst()).length,
  }
})
add('GET', '/api/admin/products', 'admin', () => store.all('products').sort((a, b) => (a.sort ?? 99) - (b.sort ?? 99)))
add('POST', '/api/admin/products', 'admin', ({ body }) => {
  req(body.name, 'Enter a product name')
  return store.put('products', {
    id: newId(), name: String(body.name), brand: body.brand ?? '', supplier: body.supplier ?? '', category: body.category ?? 'milk', unit: req(body.unit, 'Enter a unit'),
    price_paise: int(body.price_paise, 100, 10_000_000, 'Enter a price of at least ₹1'), mrp_paise: null,
    description: String(body.description ?? ''), image: String(body.image ?? ''), tags: Array.isArray(body.tags) ? body.tags.map(String) : [], active: true,
    subscribable: body.category !== 'dairy', sort: 100, created_at: nowIso(),
  })
})
add('PUT', '/api/admin/products/:id', 'admin', async ({ params, body }) => {
  const p = store.get('products', params[0]) ?? fail(404, 'Product not found')
  if (body.price_paise != null) int(body.price_paise, 100, 10_000_000, 'Enter a price of at least ₹1')
  const allowed = ['name', 'brand', 'supplier', 'unit', 'price_paise', 'mrp_paise', 'description', 'tags', 'active', 'subscribable']
  return store.put('products', { ...p, ...Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k))) })
})
add('GET', '/api/admin/plans', 'admin', () => store.all('plans').sort((a, b) => a.sort - b.sort))
add('PUT', '/api/admin/plans/:id', 'admin', async ({ params, body }) => {
  const p = store.get('plans', params[0]) ?? fail(404, 'Plan not found')
  if (body.discount_pct != null && !(Number(body.discount_pct) >= 0 && Number(body.discount_pct) <= 50)) fail(422, 'Discount must be 0–50%')
  const allowed = ['name', 'description', 'discount_pct', 'active', 'perks']
  return store.put('plans', { ...p, ...Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k))) })
})
add('GET', '/api/admin/settings', 'admin', () => getSettings())
add('PUT', '/api/admin/settings', 'admin', async ({ body }) => {
  const s = getSettings()
  if (body.skip_cutoff_hour != null) s.skip_cutoff_hour = int(body.skip_cutoff_hour, 12, 23, 'Cutoff hour must be 12–23')
  if (body.max_pause_days != null) s.max_pause_days = int(body.max_pause_days, 1, 90, 'Pause must be 1–90 days')
  if (body.delivery_fee_paise != null) s.delivery_fee_paise = int(body.delivery_fee_paise, 0, 1_000_000, 'Invalid fee')
  if (body.free_delivery_above_paise != null) s.free_delivery_above_paise = int(body.free_delivery_above_paise, 0, 100_000_000, 'Invalid amount')
  if (body.city != null) s.city = String(body.city).trim().length >= 2 ? String(body.city).trim().slice(0, 40) : fail(422, 'Enter the city name')
  if (body.demo_mode != null) s.demo_mode = body.demo_mode === true
  return store.put('settings', { ...s, id: 'global' })
})
add('GET', '/api/admin/areas', 'admin', () => store.all('areas'))
add('POST', '/api/admin/areas', 'admin', ({ body }) => {
  if (!/^\d{6}$/.test(String(body.pincode))) fail(422, 'Enter a 6-digit pincode')
  return store.put('areas', { id: body.pincode, pincode: body.pincode, name: req(body.name, 'Enter the area name'), lat: Number(body.lat) || 12.93, lng: Number(body.lng) || 77.62, active: true })
})
add('POST', '/api/admin/areas/:pin/toggle', 'admin', async ({ params }) => {
  const a = store.one('areas', (a) => a.pincode === params[0]) ?? fail(404, 'Area not found')
  return store.put('areas', { ...a, active: a.active === false })
})
const agentView = (a: Doc) => ({ id: a.id, name: a.name, phone: a.phone, email: a.email, pincodes: a.pincodes ?? [], active: a.active, roles: a.roles, has_password: !!a.password_hash })
add('GET', '/api/admin/agents', 'admin', () => store.find('users', (u) => u.roles?.includes('agent') && (isDemo() || !DEMO_ACCOUNT_IDS.includes(u.id))).map(agentView))
/** Email + password sign-in for an agent (no SMS needed, so it works with demo mode off). */
async function agentLogin(email: unknown, password: unknown, ownId: string | null) {
  const out: { email?: string; salt?: string; password_hash?: string } = {}
  if (email) {
    const e = String(email).trim().toLowerCase()
    if (!/^\S+@\S+\.\S+$/.test(e)) fail(422, 'Enter a valid email')
    if (store.one('users', (u) => u.email === e && u.id !== ownId)) fail(409, `${e} is already used by another account`)
    out.email = e
  }
  if (password) {
    const pw = String(password)
    if (pw.length < 6) fail(422, 'Password must be at least 6 characters')
    const salt = newId().slice(0, 16)
    Object.assign(out, { salt, password_hash: await hashPassword(pw, salt) })
  }
  return out
}
add('POST', '/api/admin/agents/:id/password', 'admin', async ({ params, body }) => {
  const a = store.one('users', (u) => u.id === params[0] && u.roles?.includes('agent')) ?? fail(404, 'Agent not found')
  const login = await agentLogin(body.email || a.email, body.password ?? fail(422, 'Enter a password'), a.id)
  if (!login.email) fail(422, 'Add an email for the agent to sign in with')
  return agentView(await store.put('users', { ...a, ...login }))
})
const pins = (v: unknown) => (Array.isArray(v) ? v.map(String).filter((p) => /^\d{6}$/.test(p)) : [])
add('POST', '/api/admin/agents', 'admin', async ({ body }) => {
  const phone = normalizePhone(body.phone)
  const name = String(req(body.name, 'Enter the agent name'))
  const ex = store.one('users', (u) => u.phone === phone)
  const login = await agentLogin(body.email, body.password, ex?.id ?? null)
  if (ex && (ex.roles ?? []).includes('agent')) return agentView(await store.put('users', { ...ex, pincodes: pins(body.pincodes), active: true, ...login }))
  // Phone numbers on customer profiles aren't verified, so never hand agent access to that account
  if (ex) fail(409, `${phone} is already on a customer account (${ex.name || 'no name'}). Use a different number for the agent, or ask the customer to remove it from their profile.`)
  return agentView(await store.put('users', { id: newId(), name, phone, roles: ['agent'], pincodes: pins(body.pincodes), active: true, wallet_paise: 0, created_at: nowIso(), ...login }))
})
add('PUT', '/api/admin/agents/:id', 'admin', async ({ params, body }) => {
  const a = store.one('users', (u) => u.id === params[0] && u.roles?.includes('agent')) ?? fail(404, 'Agent not found')
  const phone = body.phone ? normalizePhone(body.phone) : a.phone
  if (store.one('users', (u) => u.phone === phone && u.id !== a.id)) fail(409, `${phone} is already used by another account`)
  return store.put('users', { ...a, name: body.name ?? a.name, phone, pincodes: pins(body.pincodes) })
})
add('GET', '/api/admin/routes', 'admin', ({ query }) => {
  const d = query.get('date') || todayIst(), slot = query.get('slot')
  return store.find('deliveries', (x) => x.date === d && (!slot || x.slot === slot))
    .sort((a, b) => a.slot.localeCompare(b.slot) || String(a.agent_id).localeCompare(String(b.agent_id)) || a.sequence - b.sequence)
})
add('POST', '/api/admin/routes/generate', 'admin', async ({ body }) => {
  const d = date(body.date)
  if (d < todayIst()) fail(400, 'Routes can only be built for today or a later day')
  await store.put('route_runs', { id: d, date: d, at: nowIso(), by: 'admin' })
  return generateRoutes(d)
})
add('POST', '/api/admin/demo/run-tomorrow-today', 'admin', async () => {
  if (!isDemo()) fail(403, 'Only available in demo mode')
  // Demo helper: build the next delivery day's stops and put them on today's route, so the whole flow can be tried now.
  const t = todayIst()
  await store.put('route_runs', { id: t, date: t, at: nowIso(), by: 'demo' })
  return generateRoutes(nextCycleDate(cutoff()), t)
})
add('POST', '/api/admin/routes/assign', 'admin', async ({ body }) => {
  const agent = store.one('users', (u) => u.id === body.agent_id && u.roles?.includes('agent')) ?? fail(404, 'Agent not found')
  const stops = store.find('deliveries', (d) => (body.delivery_ids ?? []).includes(d.id) && d.status === 'pending')
  if (!stops.length) fail(400, 'No pending stops selected')
  for (const s of stops) await store.put('deliveries', { ...s, agent_id: agent.id })
  for (const key of new Set(stops.map((s) => `${s.date}|${s.slot}`))) {
    const [d, slot] = key.split('|')
    const pend = store.find('deliveries', (x) => x.date === d && x.slot === slot && x.agent_id === agent.id && x.status === 'pending')
    const done = store.find('deliveries', (x) => x.date === d && x.slot === slot && x.agent_id === agent.id && x.status !== 'pending').length
    let i = 0
    for (const s of sequenceStops(pend)) await store.put('deliveries', { ...s, sequence: done + ++i })
  }
  return { assigned: stops.length }
})
add('GET', '/api/admin/fleet', 'admin', () =>
  store.find('trips', (t) => t.status === 'active' && t.date === todayIst()).map((t) => {
    const a = store.get('users', t.agent_id)
    return { ...t, name: a?.name, phone: a?.phone, pending: store.find('deliveries', (d) => d.agent_id === t.agent_id && d.date === t.date && d.slot === t.slot && d.status === 'pending').length }
  }))
add('GET', '/api/admin/cod', 'admin', () => {
  const byAgent = new Map<string, Doc>()
  for (const e of store.find('cod_ledger', (e) => e.type === 'collected' && !e.reconciled)) {
    const a = byAgent.get(e.agent_id) ?? { id: e.agent_id, agent_id: e.agent_id, amount_paise: 0, entries: 0 }
    a.amount_paise += e.amount_paise
    a.entries++
    byAgent.set(e.agent_id, a)
  }
  for (const a of byAgent.values()) {
    a.name = store.get('users', a.agent_id)?.name
    a.declared_handover_paise = store.find('trips', (t) => t.agent_id === a.agent_id && t.status === 'ended' && !t.reconciled).reduce((s, t) => s + (t.cash_handed_over_paise ?? 0), 0)
  }
  const dues = [...new Set(store.all('cod_ledger').map((e) => e.user_id))].map((uid) => {
    const u = store.get('users', uid)
    return { user_id: uid, name: u?.name, phone: u?.phone, due_paise: codBalance(uid) }
  }).filter((d) => d.due_paise > 0).sort((a, b) => b.due_paise - a.due_paise)
  return { agents: [...byAgent.values()], customer_dues: dues }
})
add('POST', '/api/admin/cod/reconcile/:id', 'admin', async ({ params }) => {
  const entries = store.find('cod_ledger', (e) => e.agent_id === params[0] && e.type === 'collected' && !e.reconciled)
  for (const e of entries) await store.put('cod_ledger', { ...e, reconciled: true, reconciled_at: nowIso() })
  for (const t of store.find('trips', (t) => t.agent_id === params[0] && t.status === 'ended' && !t.reconciled)) await store.put('trips', { ...t, reconciled: true })
  return { reconciled_entries: entries.length }
})
add('GET', '/api/admin/customers', 'admin', ({ query }) => {
  const q = (query.get('q') ?? '').toLowerCase()
  return store.find('users', (u) => u.roles?.includes('customer') && (!q || String(u.phone ?? '').includes(q) || String(u.name ?? '').toLowerCase().includes(q)))
    .slice(0, 100).map((u) => ({ id: u.id, name: u.name, phone: u.phone, email: u.email, wallet_paise: u.wallet_paise ?? 0, created_at: u.created_at, cod_due_paise: codBalance(u.id) }))
})
add('POST', '/api/admin/customers/:id/refund', 'admin', async ({ params, body }) => {
  if (!store.get('users', params[0])) fail(404, 'Customer not found')
  const amt = int(body.amount_paise, 1, 10_000_000, 'Enter a refund amount')
  const reason = String(body.reason ?? '').trim()
  if (reason.length < 2) fail(422, 'Enter a reason')
  const e = await walletCredit(params[0], amt, 'refund', '', reason)
  await notify(params[0], 'Refund issued', `${rupees(amt)} credited to your wallet: ${reason}`, 'payment', e.id, '', true)
  return e
})
add('GET', '/api/admin/orders', 'admin', ({ query }) => store.find('orders', (o) => !query.get('status') || o.status === query.get('status')).sort(byNewest).slice(0, 200))
add('GET', '/api/admin/subscriptions', 'admin', ({ query }) => {
  const st = query.get('status')
  return store.find('subscriptions', (s) => (st ? s.status === st : s.status !== 'cancelled')).sort(byNewest).slice(0, 300).map((s) => {
    const u = store.get('users', s.user_id)
    return { ...s, customer: { name: u?.name, phone: u?.phone }, product_name: store.get('products', s.product_id)?.name }
  })
})
add('POST', '/api/admin/subscriptions/:id/toggle-pause', 'admin', async ({ params }) => {
  const s = store.get('subscriptions', params[0])
  if (!s || !['active', 'paused'].includes(s.status)) fail(400, 'Only active or paused subscriptions can be toggled')
  const st = s!.status === 'active' ? 'paused' : 'active'
  await notify(s!.user_id, `Subscription ${st === 'paused' ? 'paused' : 'resumed'}`, `MooNest support has ${st === 'paused' ? 'paused' : 'resumed'} your subscription.`, 'subscription', s!.id)
  return store.put('subscriptions', { ...s!, status: st })
})

export const _defaults = DEFAULT_SETTINGS
