import { useState } from 'react'
import { IconPalm, IconSunrise, IconSunset } from '../../components/icons'
import { Link, useParams } from 'react-router-dom'
import { api } from '../../api'
import { usePay } from '../../components/payments'
import { Badge, ConfirmButton, Empty, ErrorBox, Modal, Spinner } from '../../components/ui'
import { addDays, DAY_NAMES, fmtDate, PAYMENT_LABEL, rupees } from '../../lib'
import { useApi, useAuth, useToast } from '../../state'
import type { Address, PaymentIntent, Plan, Subscription } from '../../types'

/** Brand + product + packet colour, e.g. "Heritage Double Toned Milk · Pink packet". */
const prodTitle = (p: Subscription['product']) =>
  `${p.brand && p.brand !== 'MooNest Farms' ? p.brand + ' ' : ''}${p.name}${p.pack_label ? ` · ${p.pack_label} packet` : ''}`

const STATUS_TONE: Record<string, string> = { active: 'ok', paused: 'warn', cancelled: 'muted', pending_mandate: 'warn' }
const STATUS_LABEL: Record<string, string> = { active: 'Active', paused: 'Paused', cancelled: 'Cancelled', pending_mandate: 'AutoPay pending' }

export function Subscriptions() {
  const { data, error, loading, reload } = useApi<Subscription[]>('/api/subscriptions')
  if (loading) return <Spinner />
  if (error) return <ErrorBox message={error} onRetry={reload} />
  return (
    <div className="stack">
      <div className="row between">
        <h1>Subscriptions</h1>
        <Link to="/plans" className="btn btn-sm">+ New</Link>
      </div>
      {!data?.length && <Empty title="No subscriptions" action={<Link to="/plans" className="btn">See plans</Link>}>Get milk delivered daily, on alternate days or on days you pick.</Empty>}
      {data?.map((s) => (
        <Link key={s.id} to={`/subscriptions/${s.id}`} className="card">
          <div className="row between">
            <strong>{prodTitle(s.product)} · {s.product.unit}</strong>
            <Badge tone={STATUS_TONE[s.display_status]}>{STATUS_LABEL[s.display_status] ?? s.display_status}</Badge>
          </div>
          <p className="muted small">
            {s.quantity} × {s.plan.name}{s.plan_code === 'custom' ? ` (${s.custom_days.map((d) => DAY_NAMES[d]).join(', ')})` : ''} · {s.slot_label} · {PAYMENT_LABEL[s.payment_method]}
          </p>
          <p className="small">{rupees(s.per_delivery_paise)}/delivery · ≈ {rupees(s.est_monthly_paise)}/month</p>
        </Link>
      ))}
    </div>
  )
}

export function SubscriptionDetail() {
  const { id } = useParams()
  const { data: s, error, loading, reload, setData } = useApi<Subscription>(`/api/subscriptions/${id}`)
  const plans = useApi<Plan[]>('/api/plans')
  const addrs = useApi<Address[]>('/api/addresses')
  const toast = useToast()
  const pay = usePay()
  const { config } = useAuth()
  const [modal, setModal] = useState<null | 'pause' | 'address' | 'edit'>(null)
  const [busy, setBusy] = useState(false)

  if (loading) return <Spinner />
  if (error || !s) return <ErrorBox message={error ?? 'Not found'} onRetry={reload} />

  const act = async (path: string, body?: unknown, msg?: string, method = 'POST') => {
    setBusy(true)
    try {
      setData(await api<Subscription>(`/api/subscriptions/${s.id}${path}`, { method, body }))
      if (msg) toast(msg, 'ok')
      setModal(null)
    } catch (e) {
      toast((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }

  const retryMandate = async () => {
    setBusy(true)
    try {
      const intent = await api<PaymentIntent>(`/api/subscriptions/${s.id}/mandate`, { method: 'POST' })
      const r = await pay(intent, 'UPI AutoPay mandate for MooNest subscription')
      toast(r.status === 'paid' ? 'AutoPay active! Deliveries will begin as scheduled.' : r.message ?? 'AutoPay not completed', r.status === 'paid' ? 'ok' : 'bad')
      reload()
    } catch (e) {
      toast((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }

  const editable = (d: string) => d >= s.next_editable_date
  const activePause = s.pauses.filter((p) => p.end_date >= s.next_editable_date)

  return (
    <div className="stack">
      <div className="row between">
        <h1>{prodTitle(s.product)}</h1>
        <Badge tone={STATUS_TONE[s.display_status]}>{STATUS_LABEL[s.display_status] ?? s.display_status}</Badge>
      </div>

      {s.status === 'paused' && (
        <p className="notice">MooNest support has paused this subscription, so no deliveries are scheduled. Contact support to resume it.</p>
      )}
      {s.status === 'pending_mandate' && (
        <div className="card warn-card">
          <p>Approve the UPI AutoPay mandate to start deliveries, or switch to Wallet / COD.</p>
          <div className="row gap">
            <button className="btn" disabled={busy} onClick={retryMandate}>Set up AutoPay</button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => act('', { payment_method: 'cod' }, 'Switched to Cash on Delivery. Subscription active', 'PATCH')}>
              Use COD instead
            </button>
          </div>
        </div>
      )}

      <section className="card">
        <div className="kv"><span>Plan</span><strong>{s.quantity} × {s.product.unit} · {s.plan.name}{s.plan_code === 'custom' ? ` (${s.custom_days.map((d) => DAY_NAMES[d]).join(', ')})` : ''}</strong></div>
        <div className="kv"><span>Slot</span><strong>{s.slot_label}</strong></div>
        <div className="kv"><span>Price</span><strong>{rupees(s.per_delivery_paise)}/delivery (≈ {rupees(s.est_monthly_paise)}/mo)</strong></div>
        <div className="kv"><span>Payment</span><strong>{PAYMENT_LABEL[s.payment_method]}</strong></div>
        <div className="kv"><span>Address</span><strong>{s.address?.label}: {s.address?.line1}</strong></div>
        {s.pending_address && (
          <p className="notice">Moving to “{s.pending_address.label}” from {fmtDate(s.pending_effective_date!)}</p>
        )}
        {s.status !== 'cancelled' && (
          <div className="row gap wrap">
            <button className="btn btn-ghost btn-sm" onClick={() => setModal('edit')}>Change plan / qty</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setModal('pause')}><IconPalm size={16} /> Vacation pause</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setModal('address')}>Change address</button>
          </div>
        )}
      </section>

      {activePause.length > 0 && (
        <section className="card">
          <h3>Vacation pauses</h3>
          {activePause.map((p) => (
            <div key={p.id} className="row between">
              <span>{fmtDate(p.start_date)} → {fmtDate(p.end_date)} · auto-resumes {fmtDate(addDays(p.end_date, 1))}</span>
              <button className="link-btn" disabled={busy} onClick={() => act(`/pause/${p.id}`, undefined, 'Pause removed', 'DELETE')}>
                {p.start_date < s.next_editable_date ? 'Resume early' : 'Remove'}
              </button>
            </div>
          ))}
        </section>
      )}

      {s.status !== 'cancelled' && (
        <section className="card">
          <h3>Upcoming deliveries</h3>
          <p className="muted small">Tap to skip or restore a day. Changes close at {s.cutoff_hour}:00 the night before.</p>
          <div className="calendar">
            {s.upcoming.map((u) => (
              <button
                key={u.date}
                className={`cal-day ${u.state}`}
                disabled={busy || !editable(u.date) || u.state === 'paused'}
                onClick={() => act('/skip', { date: u.date, skip: u.state !== 'skipped' }, u.state === 'skipped' ? `Delivery restored for ${fmtDate(u.date)}` : `Skipped ${fmtDate(u.date)}`)}
                title={!editable(u.date) ? 'Cutoff passed' : undefined}
              >
                <span>{fmtDate(u.date, { weekday: 'short' })}</span>
                <strong>{fmtDate(u.date, { day: 'numeric' })}</strong>
                <small>{u.state === 'scheduled' ? (editable(u.date) ? 'Skip' : 'Locked') : u.state === 'skipped' ? 'Skipped' : 'Paused'}</small>
              </button>
            ))}
            {!s.upcoming.length && <p className="muted">No deliveries in the next 2 weeks.</p>}
          </div>
        </section>
      )}

      <div className="row gap">
        <Link to="/subscriptions" className="btn btn-ghost">All subscriptions</Link>
        {s.status === 'cancelled' ? (
          <button className="btn" disabled={busy} onClick={() => act('/resume', undefined, 'Subscription resumed')}>Resume</button>
        ) : (
          <ConfirmButton disabled={busy} onConfirm={() => act('/cancel', undefined, 'Subscription cancelled')}>
            Cancel subscription
          </ConfirmButton>
        )}
      </div>

      {modal === 'pause' && <PauseModal s={s} maxDays={config?.max_pause_days ?? 30} busy={busy} onClose={() => setModal(null)} onSave={(b) => act('/pause', b, 'Vacation pause set')} />}
      {modal === 'address' && (
        <Modal title="Change delivery address" onClose={() => setModal(null)}>
          <p className="muted small">Takes effect from {fmtDate(s.next_editable_date)} (next delivery cycle).</p>
          {addrs.data?.map((a) => (
            <button key={a.id} className={`option ${a.id === (s.pending_address?.id ?? s.address?.id) ? 'on' : ''}`} disabled={busy} onClick={() => act('/address', { address_id: a.id }, 'Address change scheduled')}>
              <div>
                <strong>{a.label}</strong>
                <p className="muted small">{[a.line1, a.area, a.pincode].filter(Boolean).join(', ')}</p>
              </div>
            </button>
          ))}
          <Link to="/account" className="link small">+ Add a new address in Account</Link>
        </Modal>
      )}
      {modal === 'edit' && <EditModal s={s} plans={plans.data ?? []} busy={busy} onClose={() => setModal(null)} onSave={(b) => act('', b, 'Subscription updated', 'PATCH')} />}
    </div>
  )
}

function PauseModal({ s, maxDays, busy, onClose, onSave }: { s: Subscription; maxDays: number; busy: boolean; onClose: () => void; onSave: (b: unknown) => void }) {
  const [start, setStart] = useState(s.next_editable_date)
  const [end, setEnd] = useState(addDays(s.next_editable_date, 6))
  const days = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1
  const invalid = days < 1 || days > maxDays
  return (
    <Modal title="Vacation pause" onClose={onClose}>
      <p className="muted small">No deliveries and no billing during the pause. Auto-resumes the day after. Up to {maxDays} days.</p>
      <div className="row gap">
        <label className="field grow">From<input type="date" className="input" min={s.next_editable_date} value={start} onChange={(e) => setStart(e.target.value)} /></label>
        <label className="field grow">To<input type="date" className="input" min={start} max={addDays(start, maxDays - 1)} value={end} onChange={(e) => setEnd(e.target.value)} /></label>
      </div>
      <p className={invalid ? 'error' : 'muted small'}>{invalid ? `Choose between 1 and ${maxDays} days` : `${days} day${days > 1 ? 's' : ''} · resumes ${fmtDate(addDays(end, 1))}`}</p>
      <button className="btn btn-block" disabled={busy || invalid} onClick={() => onSave({ start_date: start, end_date: end })}>Pause deliveries</button>
    </Modal>
  )
}

function EditModal({ s, plans, busy, onClose, onSave }: { s: Subscription; plans: Plan[]; busy: boolean; onClose: () => void; onSave: (b: unknown) => void }) {
  const [qty, setQty] = useState(s.quantity)
  const [plan, setPlan] = useState(s.plan_code)
  const [days, setDays] = useState<number[]>(s.custom_days.length ? s.custom_days : [0, 2, 4])
  const [slot, setSlot] = useState(s.slot)
  const [method, setMethod] = useState(s.payment_method)
  return (
    <Modal title="Change subscription" onClose={onClose}>
      <div className="row between">
        <span>Quantity</span>
        <div className="stepper">
          <button onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
          <span>{qty}</span>
          <button onClick={() => setQty(Math.min(10, qty + 1))}>+</button>
        </div>
      </div>
      <div className="segmented">
        {plans.map((p) => <button key={p.code} className={plan === p.code ? 'on' : ''} onClick={() => setPlan(p.code)}>{p.name}</button>)}
      </div>
      {plan === 'custom' && (
        <div className="days">
          {DAY_NAMES.map((d, i) => (
            <button key={d} className={`day ${days.includes(i) ? 'on' : ''}`} onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort())}>{d}</button>
          ))}
        </div>
      )}
      <div className="segmented">
        <button className={slot === 'morning' ? 'on' : ''} onClick={() => setSlot('morning')}><IconSunrise size={17} /> 5:30 AM</button>
        <button className={slot === 'evening' ? 'on' : ''} onClick={() => setSlot('evening')}><IconSunset size={17} /> 5:00 PM</button>
      </div>
      <select className="input" value={method} onChange={(e) => setMethod(e.target.value as Subscription['payment_method'])}>
        {(['autopay', 'wallet', 'cod'] as const).map((m) => <option key={m} value={m}>{PAYMENT_LABEL[m]}</option>)}
      </select>
      <p className="muted small">Changes apply from {fmtDate(s.next_editable_date)}.</p>
      <button className="btn btn-block" disabled={busy || (plan === 'custom' && !days.length)} onClick={() => onSave({ quantity: qty, plan_code: plan, custom_days: plan === 'custom' ? days : [], slot, payment_method: method })}>
        Save changes
      </button>
    </Modal>
  )
}
