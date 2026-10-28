import { useCallback, useEffect, useRef, useState } from 'react'
import { Route, Routes } from 'react-router-dom'
import { api, SERVER_MODE } from '../../api'
import { store } from '../../server/store'
import { IconBag, IconCash, IconCheck, IconLogout, IconNavigate, IconPhone, IconReceipt, IconSunrise, IconSunset, IconTruck, IconX } from '../../components/icons'
import MapView, { MapPoint } from '../../components/MapView'
import { Badge, BottomNav, ConfirmButton, PageTransition, Empty, ErrorBox, Greeting, Modal, Spinner, TopBar } from '../../components/ui'
import { addDays, fmtDate, fmtTime, istHour, rupees, todayIST } from '../../lib'
import PickupList, { type PickupGroup } from '../../components/PickupList'
import { useApi, useAuth, useToast } from '../../state'
import type { Slot, Stop, Tally, Trip } from '../../types'

interface RouteData {
  date: string
  agent: { id: string; name: string }
  trip: Trip | null
  stops: Stop[]
  tally: Tally
}

const FAIL_REASONS = [
  ['customer_unavailable', 'Customer unavailable'],
  ['address_not_found', 'Address not found'],
  ['gate_locked', 'Gate / door locked'],
  ['refused', 'Customer refused'],
  ['out_of_stock', 'Out of stock'],
  ['other', 'Other'],
] as const

const DEPOT = { lat: 12.9352, lng: 77.6245 }
type LatLng = { lat: number; lng: number }

/**
 * Broadcasts the agent's position every 20 s while a trip is active. Uses real GPS when the
 * browser allows it; otherwise a clearly labelled demo GPS moves toward the next pending stop.
 */
function useLocationBroadcast(active: boolean, intervalSec: number, nextStop: LatLng | null, start: LatLng | null) {
  const [state, setState] = useState<{ last?: Date; error?: string; pos?: LatLng; simulated?: boolean }>({})
  const real = useRef<GeolocationPosition | null>(null)
  const sim = useRef<LatLng | null>(null)
  const target = useRef<LatLng | null>(nextStop)
  target.current = nextStop
  useEffect(() => {
    if (!active) return
    sim.current = start ?? DEPOT
    let watch: number | null = null
    try {
      watch = navigator.geolocation?.watchPosition(
        (p) => (real.current = p),
        () => (real.current = null),
        { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
      ) ?? null
    } catch {
      watch = null
    }
    const send = async () => {
      let pos: LatLng, simulated = false
      if (real.current) pos = { lat: real.current.coords.latitude, lng: real.current.coords.longitude }
      else {
        // Demo GPS: ride up to ~350 m toward the next stop each update
        const cur = sim.current!, t = target.current
        if (t) {
          const dLat = t.lat - cur.lat, dLng = t.lng - cur.lng
          const dist = Math.hypot(dLat, dLng * Math.cos((cur.lat * Math.PI) / 180)) * 111_320
          const f = dist <= 350 ? 1 : 350 / dist
          sim.current = { lat: cur.lat + dLat * f, lng: cur.lng + dLng * f }
        }
        pos = sim.current!
        simulated = true
      }
      try {
        await api('/api/agent/location', { body: { ...pos, simulated } })
        setState({ last: new Date(), pos, simulated })
      } catch (e) {
        setState((s) => ({ ...s, error: (e as Error).message }))
      }
    }
    const first = setTimeout(send, 1500)
    const t = setInterval(send, intervalSec * 1000)
    return () => {
      if (watch != null) navigator.geolocation.clearWatch(watch)
      clearTimeout(first)
      clearInterval(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, intervalSec])
  return state
}

function useRoute() {
  const [data, setData] = useState<RouteData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      setData(await api<RouteData>('/api/agent/today'))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    load()
    return store.onChange(load)
  }, [load])
  return { data, error, reload: load }
}

export default function AgentApp() {
  const { logout } = useAuth()
  const route = useRoute()
  return (
    <div className="app agent">
      <TopBar title="Agent" right={<button className="icon-btn" onClick={logout} aria-label="Sign out"><IconLogout size={20} /></button>} />
      <main className="content">
        <PageTransition>
        <Routes>
          <Route index element={<RouteScreen route={route} />} />
          <Route path="summary" element={<Summary route={route} />} />
          <Route path="pickup" element={<Pickup />} />
        </Routes>
        </PageTransition>
      </main>
      <BottomNav items={[
        { to: '/agent', label: 'Route', icon: <IconTruck size={22} /> },
        ...(SERVER_MODE ? [{ to: '/agent/pickup', label: 'Pickup', icon: <IconBag size={22} /> }] : []),
        { to: '/agent/summary', label: 'Summary', icon: <IconReceipt size={22} /> },
      ]} />
    </div>
  )
}

function RouteScreen({ route }: { route: ReturnType<typeof useRoute> }) {
  const { user, config } = useAuth()
  const toast = useToast()
  const { data, error, reload } = route
  const [picked, setPicked] = useState<Slot | null>(null)
  const [busy, setBusy] = useState(false)
  const [action, setAction] = useState<{ type: 'deliver' | 'fail' | 'cash'; stop: Stop } | null>(null)
  const [endOpen, setEndOpen] = useState(false)
  const trip = data?.trip
  const nextPending = data?.stops.find((s) => s.slot === trip?.slot && s.status === 'pending' && s.address.lat != null)
  const gps = useLocationBroadcast(!!trip, config?.location_interval_seconds ?? 20, nextPending ? { lat: nextPending.address.lat!, lng: nextPending.address.lng! } : null, trip?.last_location ?? null)

  if (error) return <ErrorBox message={error} onRetry={reload} />
  if (!data) return <Spinner label="Loading today's route…" />

  // Default to the slot that still has work: evening after noon, otherwise whichever has pending stops
  const hasPending = (x: Slot) => data.stops.some((s) => s.slot === x && s.status === 'pending')
  const preferred: Slot = istHour() >= 12 ? 'evening' : 'morning'
  const slot: Slot = picked ?? (hasPending(preferred) ? preferred : preferred === 'evening' && hasPending('morning') ? 'morning' : preferred === 'morning' && hasPending('evening') ? 'evening' : preferred)
  const setSlot = setPicked
  const activeSlot = trip?.slot ?? slot
  const stops = data.stops.filter((s) => s.slot === activeSlot)
  const pending = stops.filter((s) => s.status === 'pending')
  const next = pending[0]

  /** Runs an action; resolves true only if it worked, so dialogs stay open on failure. */
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true)
    try {
      await fn()
      toast(msg, 'ok')
      setAction(null)
      await reload()
      return true
    } catch (e) {
      toast((e as Error).message, 'bad')
      return false
    } finally {
      setBusy(false)
    }
  }

  const points: MapPoint[] = stops
    .filter((s) => s.address.lat != null)
    .map((s) => ({ id: s.id, lat: s.address.lat!, lng: s.address.lng!, kind: s.status === 'pending' ? 'stop' : 'done', label: String(s.sequence) }))
  if (gps.pos) points.unshift({ id: 'me', lat: gps.pos.lat, lng: gps.pos.lng, kind: 'agent' })

  return (
    <div className="stack">
      <Greeting
        name={user?.name}
        subtitle={trip ? `${pending.length} stop${pending.length === 1 ? '' : 's'} left on your ${trip.slot} route` : `${data.stops.filter((s) => s.status === 'pending').length} stops today`}
      />

      <div className="stats">
        <div><strong>{data.tally.delivered}</strong><span>Delivered</span></div>
        <div><strong>{data.tally.pending}</strong><span>Pending</span></div>
        <div><strong>{data.tally.failed + data.tally.skipped}</strong><span>Missed/Skipped</span></div>
        <div><strong>{rupees(data.tally.cash_collected_paise)}</strong><span>Cash</span></div>
      </div>

      {!trip ? (
        <div className="card">
          <div className="segmented">
            <button className={slot === 'morning' ? 'on' : ''} onClick={() => setSlot('morning')}><IconSunrise size={17} /> Morning ({data.stops.filter((s) => s.slot === 'morning').length})</button>
            <button className={slot === 'evening' ? 'on' : ''} onClick={() => setSlot('evening')}><IconSunset size={17} /> Evening ({data.stops.filter((s) => s.slot === 'evening').length})</button>
          </div>
          <button className="btn btn-block btn-lg" disabled={busy || !stops.some((s) => s.status === 'pending')} onClick={() => run(() => api('/api/agent/trips/start', { body: { slot } }), 'Trip started. Sharing live location')}>
            ▶ Start trip
          </button>
          <p className="muted small">Starting a trip shares your location with customers every {config?.location_interval_seconds ?? 20}s until you end it.</p>
        </div>
      ) : (
        <div className="card trip-card">
          <div className="row between">
            <div>
              <Badge tone="ok">● Trip live</Badge>
              <p className="muted small">
                Started {fmtTime(trip.started_at)} · {gps.error ? <span className="bad">{gps.error}</span> : gps.last ? `Location sent ${fmtTime(gps.last.toISOString())}${gps.simulated ? ' · demo GPS (location access is off here)' : ''}` : 'Getting location…'}
              </p>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setEndOpen(true)}>End trip</button>
          </div>
        </div>
      )}

      {points.length > 0 && <MapView points={points} height={240} />}

      {!stops.length && <Empty title="No stops in this slot">Routes are built after the {config?.skip_cutoff_hour}:00 cutoff the night before. To try it now, log in as admin and tap “Run tomorrow's deliveries today”.</Empty>}

      {stops.map((s) => (
        <article key={s.id} className={`card stop stop-${s.status} ${next?.id === s.id ? 'next' : ''}`}>
          <div className="row between">
            <div className="row gap">
              <span className="seq">{s.sequence}</span>
              <div>
                <strong>{s.customer_name || 'Customer'}</strong>
                <p className="muted small">{[s.address.line1, s.address.line2, s.address.landmark, s.address.area].filter(Boolean).join(', ')}</p>
              </div>
            </div>
            <Badge tone={{ pending: 'info', delivered: 'ok', skipped: 'muted', failed: 'bad' }[s.status]}>{s.status}</Badge>
          </div>
          <p className="small">{s.items.map((i) => `${i.name} ${i.unit} × ${i.qty}`).join(' · ')}</p>
          <div className="row between small">
            <span>
              {s.payment_method === 'cod' ? (
                <><IconCash size={15} /> COD {rupees(s.amount_paise)}{s.cod_due_paise > 0 && <> · total due <strong>{rupees(s.cod_due_paise)}</strong></>}</>
              ) : (
                <><IconCheck size={15} /> Prepaid ({s.payment_method})</>
              )}
            </span>
            <span>
              <a href={`tel:+91${s.customer_phone}`} className="link inline-icon"><IconPhone size={15} /> Call</a>
              {s.address.lat != null && (
                <> · <a className="link inline-icon" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${s.address.lat},${s.address.lng}`}><IconNavigate size={15} /> Navigate</a></>
              )}
            </span>
          </div>
          {s.failure_reason && <p className="bad small">Reason: {s.failure_reason}</p>}
          {s.status === 'pending' && (
            <div className="row gap wrap">
              <button className="btn btn-sm" disabled={!trip || busy} onClick={() => setAction({ type: 'deliver', stop: s })}><IconCheck size={16} /> Delivered</button>
              <ConfirmButton className="btn btn-ghost btn-sm" confirmLabel="Tap again to skip" disabled={!trip || busy} onConfirm={() => run(() => api(`/api/agent/deliveries/${s.id}/skipped`, { method: 'POST' }), 'Marked skipped')}>Skip</ConfirmButton>
              <button className="btn btn-danger btn-sm" disabled={!trip || busy} onClick={() => setAction({ type: 'fail', stop: s })}><IconX size={16} /> Failed</button>
            </div>
          )}
          {s.payment_method === 'cod' && s.status === 'delivered' && (
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setAction({ type: 'cash', stop: s })}>
              <IconCash size={16} /> {s.cod_collected_paise ? `Collected ${rupees(s.cod_collected_paise)}, add more` : 'Record cash received'}
            </button>
          )}
          {!trip && s.status === 'pending' && <p className="muted small">Start the trip to update stops.</p>}
        </article>
      ))}

      {action?.type === 'deliver' && <DeliverModal stop={action.stop} busy={busy} onClose={() => setAction(null)} onSubmit={(form) => run(() => api(`/api/agent/deliveries/${action.stop.id}/delivered`, { form }), 'Marked delivered. Customer notified')} />}
      {action?.type === 'fail' && <FailModal busy={busy} onClose={() => setAction(null)} onSubmit={(b) => run(() => api(`/api/agent/deliveries/${action.stop.id}/failed`, { body: b }), 'Marked failed. Customer notified')} />}
      {action?.type === 'cash' && <CashModal stop={action.stop} busy={busy} onClose={() => setAction(null)} onSubmit={(amount) => run(() => api(`/api/agent/deliveries/${action.stop.id}/cash`, { body: { amount_paise: amount } }), 'Cash recorded')} />}
      {endOpen && (
        <EndTripModal
          tally={data.tally}
          pendingLeft={pending.length}
          busy={busy}
          onClose={() => setEndOpen(false)}
          onSubmit={(b) => run(() => api('/api/agent/trips/end', { body: b }), 'Trip ended').then((ok) => ok && setEndOpen(false))}
        />
      )}
    </div>
  )
}

function DeliverModal({ stop, busy, onClose, onSubmit }: { stop: Stop; busy: boolean; onClose: () => void; onSubmit: (f: FormData) => void }) {
  const [cash, setCash] = useState(stop.payment_method === 'cod' ? String(stop.amount_paise / 100) : '')
  return (
    <Modal title={`Deliver to ${stop.customer_name || 'customer'}`} onClose={onClose}>
      <p className="small">{stop.items.map((i) => `${i.name} ${i.unit} × ${i.qty}`).join(' · ')}</p>
      {stop.payment_method === 'cod' && (
        <label className="field">
          Cash received now (₹). Leave 0 if they'll settle weekly.
          <input className="input" type="number" min={0} value={cash} onChange={(e) => setCash(e.target.value)} />
        </label>
      )}
      <button
        className="btn btn-block"
        disabled={busy}
        onClick={() => {
          const f = new FormData()
          f.append('cash_paise', String(Math.round(Number(cash || 0) * 100)))
          onSubmit(f)
        }}
      >
        {busy ? 'Saving…' : 'Confirm delivered'}
      </button>
    </Modal>
  )
}

function FailModal({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (b: { reason: string; note: string }) => void }) {
  const [reason, setReason] = useState<string>('customer_unavailable')
  const [note, setNote] = useState('')
  return (
    <Modal title="Why couldn't you deliver?" onClose={onClose}>
      {FAIL_REASONS.map(([v, t]) => (
        <label key={v} className={`option ${reason === v ? 'on' : ''}`}>
          <input type="radio" name="reason" checked={reason === v} onChange={() => setReason(v)} /> {t}
        </label>
      ))}
      <input className="input" placeholder="Note (optional)" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
      <p className="muted small">The customer is credited or rescheduled automatically based on their preference.</p>
      <button className="btn btn-danger btn-block" disabled={busy} onClick={() => onSubmit({ reason, note })}>Mark failed</button>
    </Modal>
  )
}

function CashModal({ stop, busy, onClose, onSubmit }: { stop: Stop; busy: boolean; onClose: () => void; onSubmit: (paise: number) => void }) {
  const due = stop.cod_due_paise || 0
  const [amt, setAmt] = useState(String(due / 100))
  const paise = Math.round(Number(amt || 0) * 100)
  return (
    <Modal title="Cash received" onClose={onClose}>
      <p>Customer's total cash due: <strong>{rupees(due)}</strong></p>
      {due > 0 ? (
        <>
          <input className="input" type="number" min={1} max={due / 100} value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Amount in rupees" />
          {paise > due && <p className="error">That's more than the {rupees(due)} due.</p>}
          <button className="btn btn-block" disabled={busy || !(paise > 0) || paise > due} onClick={() => onSubmit(paise)}>Record {rupees(paise)}</button>
        </>
      ) : (
        <p className="muted">Nothing is due from this customer.</p>
      )}
    </Modal>
  )
}

function EndTripModal({ tally, pendingLeft, busy, onClose, onSubmit }: { tally: Tally; pendingLeft: number; busy: boolean; onClose: () => void; onSubmit: (b: unknown) => void }) {
  const [note, setNote] = useState('')
  const [cash, setCash] = useState(String(tally.cash_collected_paise / 100))
  return (
    <Modal title="End trip & hand off" onClose={onClose}>
      {pendingLeft > 0 && <p className="notice bad">{pendingLeft} stop{pendingLeft > 1 ? 's are' : ' is'} still pending. Mark them before ending if you can.</p>}
      <div className="kv"><span>Delivered</span><strong>{tally.delivered}</strong></div>
      <div className="kv"><span>Failed / skipped</span><strong>{tally.failed + tally.skipped}</strong></div>
      <div className="kv"><span>Cash collected today</span><strong>{rupees(tally.cash_collected_paise)}</strong></div>
      <label className="field">Cash handed over (₹)<input className="input" type="number" min={0} value={cash} onChange={(e) => setCash(e.target.value)} /></label>
      <input className="input" placeholder="Handoff note (empty crates, issues…)" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
      <button className="btn btn-block" disabled={busy} onClick={() => onSubmit({ handoff_note: note, cash_handed_over_paise: Math.round(Number(cash || 0) * 100) })}>End trip</button>
    </Modal>
  )
}

/** Packets to collect from the dairy for today or tomorrow. */
function Pickup() {
  const [day, setDay] = useState<'today' | 'tomorrow'>('today')
  const date = day === 'today' ? todayIST() : addDays(todayIST(), 1)
  const { data, error, reload } = useApi<PickupGroup & { date: string; estimate: boolean }>(`/api/agent/pickup?date=${date}`, [date])
  return (
    <div className="stack">
      <h1>Pickup list</h1>
      <div className="seg seg-sm" style={{ '--n': 2, '--i': day === 'today' ? 0 : 1 } as React.CSSProperties} role="tablist">
        <button className={day === 'today' ? 'on' : ''} role="tab" aria-selected={day === 'today'} onClick={() => setDay('today')}>Today</button>
        <button className={day === 'tomorrow' ? 'on' : ''} role="tab" aria-selected={day === 'tomorrow'} onClick={() => setDay('tomorrow')}>Tomorrow</button>
      </div>
      {error ? <ErrorBox message={error} onRetry={reload} /> : !data ? <Spinner /> : (
        <section className="card stack-sm">
          <p className="muted small estimate-note">
            {fmtDate(data.date)}
            {data.estimate ? ' · Estimate: the final list is ready after the nightly cutoff, when skips are closed.' : ' · Final list for your route.'}
          </p>
          <PickupList group={data} />
        </section>
      )}
    </div>
  )
}

function Summary({ route }: { route: ReturnType<typeof useRoute> }) {
  const [data, setData] = useState<{ tally: Tally; trips: Trip[]; collections: { id: string; amount_paise: number; created_at: string }[] } | null>(null)
  useEffect(() => {
    api<typeof data>('/api/agent/summary').then(setData).catch(() => null)
  }, [route.data])
  if (!data) return <Spinner />
  return (
    <div className="stack">
      <h1>Today's summary</h1>
      <div className="stats">
        <div><strong>{data.tally.total}</strong><span>Stops</span></div>
        <div><strong>{data.tally.delivered}</strong><span>Delivered</span></div>
        <div><strong>{data.tally.failed}</strong><span>Failed</span></div>
        <div><strong>{rupees(data.tally.cash_collected_paise)}</strong><span>Cash</span></div>
      </div>
      <section className="card list">
        <h3>Trips</h3>
        {!data.trips.length && <p className="muted">No trips yet today.</p>}
        {data.trips.map((t) => (
          <div key={t.id} className="row between">
            <div>
              <strong>{t.slot === 'morning' ? 'Morning' : 'Evening'}</strong>
              <p className="muted small">{fmtTime(t.started_at)} – {t.ended_at ? fmtTime(t.ended_at) : 'in progress'}{t.handoff_note ? ` · ${t.handoff_note}` : ''}</p>
            </div>
            {t.status === 'ended' ? <span className="small">Handed over {rupees(t.cash_handed_over_paise)}</span> : <Badge tone="ok">Live</Badge>}
          </div>
        ))}
      </section>
      <section className="card list">
        <h3>Cash collections</h3>
        {!data.collections.length && <p className="muted">No cash collected yet.</p>}
        {data.collections.map((c) => (
          <div key={c.id} className="row between"><span>{fmtTime(c.created_at)}</span><strong>{rupees(c.amount_paise)}</strong></div>
        ))}
      </section>
    </div>
  )
}
