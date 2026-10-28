/** Business rules, ported from the FastAPI backend (app/services/*). */
import { addDays } from '../lib'
import { Doc, store } from './store'

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}
export const fail = (status: number, message: string): never => {
  throw new HttpError(status, message)
}

// ---------------- utils ----------------
export const PHONE_RE = /^[6-9]\d{9}$/
export function normalizePhone(raw: unknown): string {
  let d = String(raw ?? '').replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2)
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  if (!PHONE_RE.test(d)) fail(422, 'Enter a valid 10-digit mobile number')
  return d
}
export const newId = () => (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '')
export const nowIso = () => new Date().toISOString()
const istFmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' })
export const istDate = (d: Date | string = new Date()) => istFmt.format(typeof d === 'string' ? new Date(d) : d)
export const istHourNow = () => Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(new Date()))
export const todayIst = () => istDate()
export const nextCycleDate = (cutoff: number) => addDays(todayIst(), istHourNow() < cutoff ? 1 : 2)
export const weekday = (iso: string) => (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7 // 0=Mon
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000)
export const isIsoDate = (s: unknown) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))
export const rupees = (p: number) => '₹' + (p / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })
export const fmtDay = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number) {
  const r = 6371, rad = Math.PI / 180
  const dp = (lat2 - lat1) * rad, dl = (lng2 - lng1) * rad
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dl / 2) ** 2
  return 2 * r * Math.asin(Math.sqrt(a))
}
/** Shown on orders, routes and invoices: brand + product, except our own label. */
export const displayName = (p: Doc) =>
  (p.brand && p.brand !== 'MooNest Farms' ? `${p.brand} ${p.name}` : p.name) + (p.pack_label ? ` (${p.pack_label} packet)` : '')

export const SLOT_LABEL: Record<string, string> = { morning: '5:30 AM', evening: '5:00 PM' }
export const DEPOT = { lat: 12.9352, lng: 77.6245 }
export const LOCATION_INTERVAL_SECONDS = 10
export const SIGNAL_LOST_AFTER_SECONDS = 70

// ---------------- settings ----------------
export const DEFAULT_SETTINGS = {
  id: 'global', skip_cutoff_hour: 22, max_pause_days: 30, delivery_fee_paise: 1000, free_delivery_above_paise: 15000,
  slots: [{ code: 'morning', label: '5:30 AM', time: '05:30' }, { code: 'evening', label: '5:00 PM', time: '17:00' }],
  city: 'Bengaluru', demo_mode: true,
}
export const getSettings = () => ({ ...DEFAULT_SETTINGS, ...(store.get('settings', 'global') ?? {}) })
/** Demo mode (Admin → Overview): test shortcuts on or off. Same switch as the server's. */
export const isDemo = () => getSettings().demo_mode !== false
/** Seeded demo accounts: they can only sign in while demo mode is on. */
export const DEMO_ACCOUNT_IDS = ['u-agent-ravi', 'u-agent-suresh', 'u-demo-customer']
export const cutoff = () => Number(getSettings().skip_cutoff_hour)

// ---------------- wallet / COD ----------------
export const walletBalance = (uid: string) => Number(store.get('users', uid)?.wallet_paise ?? 0)

async function ledger(uid: string, type: 'credit' | 'debit', amount: number, reason: string, ref: string, note: string, id?: string) {
  const u = store.get('users', uid)!
  const bal = Number(u.wallet_paise ?? 0) + (type === 'credit' ? amount : -amount)
  await store.put('users', { ...u, wallet_paise: bal })
  return store.put('wallet_ledger', { id: id ?? newId(), user_id: uid, type, amount_paise: amount, reason, ref, note, balance_after_paise: bal, created_at: nowIso() })
}
export const walletCredit = (uid: string, amount: number, reason: string, ref = '', note = '') => ledger(uid, 'credit', amount, reason, ref, note)
export async function walletDebit(uid: string, amount: number, reason: string, ref = '', note = '', id?: string) {
  if (walletBalance(uid) < amount) return null
  return ledger(uid, 'debit', amount, reason, ref, note, id)
}
export const codAddDue = (uid: string, amount: number, ref: string, note = '') =>
  store.put('cod_ledger', { id: newId(), user_id: uid, type: 'due', amount_paise: amount, ref, note, created_at: nowIso() })
export const codCollect = (uid: string, agentId: string, amount: number, ref: string, tripId: string, date: string) =>
  store.put('cod_ledger', { id: newId(), user_id: uid, agent_id: agentId, type: 'collected', amount_paise: amount, ref, trip_id: tripId, date, reconciled: false, created_at: nowIso() })
export function codBalance(uid: string) {
  let t = 0
  for (const e of store.find('cod_ledger', (e) => e.user_id === uid)) t += e.type === 'due' ? e.amount_paise : -e.amount_paise
  return t
}

// ---------------- subscription calendar ----------------
export function planMatches(sub: Doc, d: string) {
  if (d < sub.start_date) return false
  if (sub.plan_code === 'daily') return true
  if (sub.plan_code === 'alternate') return daysBetween(sub.start_date, d) % 2 === 0
  if (sub.plan_code === 'custom') return (sub.custom_days ?? []).includes(weekday(d))
  return false
}
export const pausedOn = (sub: Doc, d: string) => (sub.pauses ?? []).find((p: Doc) => p.start_date <= d && d <= p.end_date) ?? null
export const deliversOn = (sub: Doc, d: string) => sub.status === 'active' && planMatches(sub, d) && !(sub.skips ?? []).includes(d) && !pausedOn(sub, d)
export function upcomingDates(sub: Doc, start: string, days = 14) {
  const out: { date: string; state: string }[] = []
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i)
    if (!planMatches(sub, d) || sub.status !== 'active') continue
    out.push({ date: d, state: (sub.skips ?? []).includes(d) ? 'skipped' : pausedOn(sub, d) ? 'paused' : 'scheduled' })
  }
  return out
}
export function planByCode(code: string) {
  const p = store.one('plans', (p) => p.code === code)
  if (!p || p.active === false) fail(400, 'This plan is not available')
  return p!
}
export const unitPrice = (product: Doc, plan: Doc | null) => Math.round((product.price_paise * (100 - Number(plan?.discount_pct ?? 0))) / 100)
/** Areas are managed in Admin (one switched off is never served). In demo mode any other valid
 *  Indian pincode is accepted as a test area at the depot, routed to the demo agent. */
export function serviceable(pin: string): Doc | null {
  const area = store.one('areas', (a) => a.pincode === pin)
  if (area) return area.active !== false ? area : null
  return isDemo() && /^[1-9]\d{5}$/.test(pin) ? { id: pin, pincode: pin, name: `Pincode ${pin} (test mode)`, ...DEPOT, active: true, test_area: true } : null
}

// ---------------- notifications ----------------
export async function notify(uid: string, title: string, body: string, kind = 'info', ref = '', image_url = '', sms = false) {
  // SMS needs a server (Twilio); in this build notifications are in-app (and browser alerts where allowed).
  return store.put('notifications', { id: newId(), user_id: uid, title, body, kind, ref, image_url, read: false, sms_requested: sms, created_at: nowIso() })
}

// ---------------- routes ----------------
// with demo mode off, demo agents can't sign in, so they never get stops
const isAgent = (u: Doc) => (u.roles ?? []).includes('agent') && u.active !== false && (isDemo() || !DEMO_ACCOUNT_IDS.includes(u.id))
const agentForPincode = (pin: string) =>
  (store.one('users', (u) => isAgent(u) && (u.pincodes ?? []).includes(pin)) ??
    // test areas (demo mode) go to the demo agent, else any active agent
    (isDemo() ? store.one('users', (u) => u.id === 'u-agent-ravi' && isAgent(u)) ?? store.one('users', isAgent) : null))?.id ?? null

function sequence(stops: Doc[]) {
  const remaining = [...stops]
  let { lat, lng } = DEPOT
  const ordered: Doc[] = []
  while (remaining.length) {
    let best = 0, bestD = Infinity
    remaining.forEach((s, i) => {
      const d = s.address.lat == null ? 1e4 : haversineKm(lat, lng, s.address.lat, s.address.lng)
      if (d < bestD) (bestD = d), (best = i)
    })
    const nxt = remaining.splice(best, 1)[0]
    ordered.push(nxt)
    if (nxt.address.lat != null) ({ lat, lng } = nxt.address)
  }
  return ordered
}
export { sequence as sequenceStops }

async function chargeSubscription(sub: Doc, user: Doc, amount: number, d: string): Promise<[boolean, string]> {
  const ref = `sub:${sub.id}:${d}`
  if (sub.payment_method === 'wallet') {
    const chargeId = `chg_${sub.id}_${d}`
    if (store.get('wallet_ledger', chargeId)) return [true, 'paid'] // already charged (idempotent)
    const e = await walletDebit(user.id, amount, 'subscription_delivery', ref, `${sub.product_name} × ${sub.quantity} on ${fmtDay(d)}`, chargeId)
    return e ? [true, 'paid'] : [false, 'low_wallet_balance']
  }
  if (sub.payment_method === 'autopay') {
    if (sub.mandate?.status !== 'active') return [false, 'mandate_inactive']
    const pid = `ap_${sub.id}_${d}`
    if (!store.get('payments', pid))
      await store.put('payments', { id: pid, user_id: user.id, purpose: 'autopay_debit', amount_paise: amount, ref, status: 'paid', demo: true, created_at: nowIso() })
    return [true, 'paid']
  }
  return [true, 'cod_pending']
}

/** Build stops for date `d`. Delivery ids are deterministic, so re-running (on any device) never duplicates. */
export async function generateRoutes(d: string, stampDate?: string) {
  const date = stampDate ?? d
  let created = 0, skipped = 0
  const bySlot: Record<string, any[]> = { morning: [], evening: [] }
  const exists = (kind: string, ref: string) => {
    const s = store.get('deliveries', `${date}_${kind}_${ref}`)
    return !!s && !(kind === 'order' && s.status === 'failed') // a rescheduled failed order gets a new stop
  }

  for (let sub of store.find('subscriptions', (s) => s.status === 'active')) {
    try {
      if (exists('subscription', sub.id) || !deliversOn(sub, d)) continue
      if (sub.pending_address_id && d >= sub.pending_effective_date) {
        const { pending_address_id, pending_effective_date: _e, ...rest } = sub
        sub = await store.put('subscriptions', { ...rest, address_id: pending_address_id })
      }
      const user = store.get('users', sub.user_id), product = store.get('products', sub.product_id)
      const plan = store.one('plans', (p) => p.code === sub.plan_code), addr = store.get('addresses', sub.address_id)
      if (!user || !product || !addr) continue
      const unit = unitPrice(product, plan), amount = unit * sub.quantity
      const [ok, info] = await chargeSubscription({ ...sub, product_name: product.name }, user, amount, d)
      if (!ok) {
        skipped++
        const msg: Record<string, string> = {
          low_wallet_balance: `Your ${SLOT_LABEL[sub.slot]} delivery on ${fmtDay(d)} was skipped: wallet balance is below ${rupees(amount)}. Top up to resume.`,
          mandate_inactive: "Your UPI AutoPay mandate isn't active, so this delivery was skipped. Set it up again or switch to Wallet/COD.",
        }
        await notify(user.id, 'Delivery skipped', msg[info], 'warning', sub.id, '', true)
        continue
      }
      bySlot[sub.slot].push({
        kind: 'subscription', ref_id: sub.id, user_id: user.id, customer_name: user.name ?? '',
        customer_phone: addr.contact_phone || user.phone || '', address: addr, slot: sub.slot,
        items: [{ product_id: product.id, name: displayName(product), unit: product.unit, qty: sub.quantity, price_paise: unit }],
        amount_paise: amount, payment_method: sub.payment_method, payment_status: info,
      })
    } catch (e) {
      // one bad subscription must never stop the rest of the route
      console.error('Skipping subscription', sub.id, e)
      skipped++
    }
  }
  for (const o of store.find('orders', (o) => o.delivery_date === d && o.status === 'confirmed')) {
    if (exists('order', o.id)) continue
    const user = store.get('users', o.user_id)
    bySlot[o.slot].push({
      kind: 'order', ref_id: o.id, user_id: o.user_id, customer_name: user?.name ?? '',
      customer_phone: o.address.contact_phone || user?.phone || '', address: o.address, slot: o.slot, items: o.items,
      amount_paise: o.total_paise, payment_method: o.payment_method, payment_status: o.payment_status,
    })
  }
  for (const r of store.find('redeliveries', (r) => r.date === d && !r.done)) {
    if (exists('redelivery', r.id)) continue
    bySlot[r.stop.slot].push({ ...r.stop, kind: 'redelivery', ref_id: r.id, original_delivery_id: r.delivery_id })
    await store.put('redeliveries', { ...r, done: true })
  }
  for (const [slot, stops] of Object.entries(bySlot)) {
    const groups = new Map<string | null, Doc[]>()
    for (const s of stops) {
      s.agent_id = agentForPincode(s.address.pincode)
      groups.set(s.agent_id, [...(groups.get(s.agent_id) ?? []), s])
    }
    for (const [agentId, group] of groups) {
      const start = store.find('deliveries', (x) => x.date === date && x.slot === slot && x.agent_id === agentId).length
      let i = 0
      for (const s of sequence(group)) {
        const id = `${date}_${s.kind}_${s.ref_id}`
        await store.put('deliveries', { ...s, id, date, sequence: start + ++i, status: 'pending', cod_collected_paise: 0, created_at: nowIso() })
        if (s.kind === 'order') await store.patch('orders', s.ref_id, { delivery_id: id })
        created++
      }
    }
  }
  return { date, created, skipped }
}

/** Failed stop → wallet credit (default) or redeliver next day, per the customer's preference. */
export async function handleMissed(dl: Doc, reasonText: string) {
  const user = store.get('users', dl.user_id) ?? ({} as Doc)
  const pref = user.missed_pref ?? 'wallet_credit'
  const prepaid = dl.payment_status === 'paid'
  let outcome = 'none', body: string
  if (pref === 'redeliver') {
    // next day, or the first day whose route isn't built yet if it's already past the cutoff
    const n = nextCycleDate(cutoff())
    const nxt = addDays(dl.date, 1) > n ? addDays(dl.date, 1) : n
    if (dl.kind !== 'order') {
      // orders are simply rescheduled below (one stop, one COD due)
      const stop = Object.fromEntries(['user_id', 'customer_name', 'customer_phone', 'address', 'slot', 'items', 'amount_paise', 'payment_method', 'payment_status'].map((k) => [k, dl[k]]))
      await store.put('redeliveries', { id: newId(), delivery_id: dl.id, date: nxt, stop, done: false, created_at: nowIso() })
    }
    outcome = `redeliver:${nxt}`
    body = `We couldn't deliver today (${reasonText}). We'll bring it on ${fmtDay(nxt)} (${SLOT_LABEL[dl.slot]}).`
  } else if (prepaid) {
    await walletCredit(dl.user_id, dl.amount_paise, 'missed_delivery_credit', dl.id, `Missed delivery on ${fmtDay(dl.date)}`)
    outcome = 'wallet_credit'
    body = `We couldn't deliver today (${reasonText}). ${rupees(dl.amount_paise)} has been credited to your wallet.`
  } else body = `We couldn't deliver today (${reasonText}). You won't be charged for it.`
  if (dl.kind === 'order') {
    let upd: Record<string, unknown> = { status: 'failed', failure_reason: reasonText }
    if (outcome === 'wallet_credit') upd.payment_status = 'refunded_to_wallet'
    if (outcome.startsWith('redeliver')) {
      const { delivery_id: _d, ...order } = store.get('orders', dl.ref_id) ?? ({} as Doc)
      if (order.id) await store.put('orders', { ...order, status: 'confirmed', delivery_date: outcome.split(':')[1], rescheduled: true })
    } else await store.patch('orders', dl.ref_id, upd)
  }
  await notify(dl.user_id, 'Delivery missed', body, 'warning', dl.id, '', true)
  return outcome
}

// ---------------- tracking ----------------
export function etaMinutes(loc: Doc | null, ahead: Doc[], target: Doc) {
  if (!loc) return null
  const pts = [...ahead, target].map((s) => s.address).filter((a) => a.lat != null)
  let km = 0, p = { lat: loc.lat, lng: loc.lng }
  for (const a of pts) {
    km += haversineKm(p.lat, p.lng, a.lat, a.lng)
    p = a
  }
  return Math.max(1, Math.round(((km * 1.3) / 18) * 60 + 2 * ahead.length))
}
export function signalState(loc: Doc | null) {
  if (!loc) return { signal: 'none', age_seconds: null }
  const age = (Date.now() - Date.parse(loc.ts)) / 1000
  return { signal: age <= SIGNAL_LOST_AFTER_SECONDS ? 'live' : 'lost', age_seconds: Math.round(age) }
}
export function trackingPayload(dl: Doc) {
  const trip = store.find('trips', (t) => t.agent_id === dl.agent_id && t.date === dl.date && t.slot === dl.slot).sort((a, b) => b.started_at.localeCompare(a.started_at))[0] ?? null
  const agent = dl.agent_id ? store.get('users', dl.agent_id) : null
  const loc = trip?.last_location ?? null
  const ahead = trip?.status === 'active'
    ? store.find('deliveries', (s) => s.date === dl.date && s.slot === dl.slot && s.agent_id === dl.agent_id && s.status === 'pending' && s.sequence < dl.sequence).sort((a, b) => a.sequence - b.sequence)
    : []
  return {
    delivery_id: dl.id, status: dl.status, slot: dl.slot, date: dl.date,
    destination: { lat: dl.address.lat, lng: dl.address.lng },
    trip_status: trip?.status ?? 'not_started', agent: agent ? { name: agent.name || 'Milk agent' } : null,
    location: loc, ...signalState(loc), stops_before_you: ahead.length,
    eta_minutes: trip?.status === 'active' && dl.status === 'pending' ? etaMinutes(loc, ahead, dl) : null,
    photo_url: dl.photo_url, delivered_at: dl.delivered_at, items: dl.items,
  }
}
