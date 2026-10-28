import { useState } from 'react'
import { NavLink, Route, Routes } from 'react-router-dom'
import { api, SERVER_MODE, SHARED_APP_URL } from '../../api'
import { BarList, ColumnChart } from '../../components/Charts'
import PickupList, { type PickupGroup } from '../../components/PickupList'
import MapView from '../../components/MapView'
import { Badge, DemoBar, ErrorBox, Greeting, PageTransition, Spinner } from '../../components/ui'
import { fmtDate, fmtTime, rupees, todayIST } from '../../lib'
import { useApi, useAuth, useToast } from '../../state'
import type { Plan, Product, Stop, Subscription, Trip } from '../../types'

const TABS = [
  ['', 'Overview'], ['routes', 'Routes'], ['fleet', 'Live fleet'], ['cod', 'COD'], ['catalog', 'Products & plans'],
  ['subscriptions', 'Subscriptions'], ['customers', 'Customers'], ['agents', 'Agents & areas'],
] as const

export default function AdminApp() {
  const { user, logout } = useAuth()
  return (
    <div className="admin">
      <aside className="admin-nav">
        <div className="brand"><svg width={26} height={26} viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#2f6b4f" /><path d="M24 14h16v6l4 8v22a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4V28l4-8z" fill="#fffaf0" /><rect x="24" y="34" width="16" height="10" rx="2" fill="#f2c14e" /></svg> MooNest Admin</div>
        <nav className="admin-tabs" aria-label="Admin sections">
          {TABS.map(([p, l]) => <NavLink key={p} to={`/admin/${p}`} end>{l}</NavLink>)}
        </nav>
        <button className="link-btn" onClick={logout}>Log out</button>
      </aside>
      <main className="admin-main">
        <Greeting name={user?.name} />
        <PageTransition>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="routes" element={<RoutesTab />} />
          <Route path="fleet" element={<Fleet />} />
          <Route path="cod" element={<Cod />} />
          <Route path="catalog" element={<Catalog />} />
          <Route path="subscriptions" element={<Subs />} />
          <Route path="customers" element={<Customers />} />
          <Route path="agents" element={<Agents />} />
        </Routes>
        </PageTransition>
      </main>
    </div>
  )
}

function Overview() {
  const { config } = useAuth()
  const { data, error, reload } = useApi<Record<string, number & Record<string, number>>>('/api/admin/overview')
  if (error) return <ErrorBox message={error} onRetry={reload} />
  if (!data) return <Spinner />
  const d = data as unknown as { deliveries: Record<string, number>; unassigned: number; delivered_value_paise: number; active_subscriptions: number; customers: number; agents: number; active_trips: number; orders_today: number }
  return (
    <div className="stack">
      <div className="stats">
        <div><strong>{d.deliveries.delivered}/{Object.values(d.deliveries).reduce((a, b) => a + b, 0)}</strong><span>Delivered today</span></div>
        <div><strong>{d.deliveries.pending}</strong><span>Pending</span></div>
        <div><strong>{d.deliveries.failed}</strong><span>Failed</span></div>
        <div><strong>{rupees(d.delivered_value_paise)}</strong><span>Delivered value</span></div>
      </div>
      <div className="stats">
        <div><strong>{d.active_subscriptions}</strong><span>Active subs</span></div>
        <div><strong>{d.customers}</strong><span>Customers</span></div>
        <div><strong>{d.active_trips}/{d.agents}</strong><span>Agents on trip</span></div>
        <div><strong>{d.orders_today}</strong><span>Orders placed today</span></div>
      </div>
      {d.unassigned > 0 && <p className="notice bad">{d.unassigned} stops today have no agent. Assign them in Routes.</p>}
      {SERVER_MODE && <Dashboard />}
      <DemoModeCard />
      <StorageCard key={String(config?.demo_mode)} />
      {config?.demo_mode && <RunTomorrowToday onDone={reload} />}
      <DemoBar />
    </div>
  )
}

/** Where the data lives, and whether everyone shares it. */
function StorageCard() {
  const { data } = useApi<{ storage?: string }>('/api/admin/settings')
  const mode = (window as unknown as { __moonestMode?: string }).__moonestMode
  const [title, text, ok] =
    mode === 'server'
      ? data?.storage === 'demo'
        ? ['Demo mode: nothing is saved', 'Everyone shares a temporary copy of your data. Switch demo mode off to go back to the saved data; everything done in demo mode is thrown away.', false]
        : data?.storage === 'permanent'
        ? ['Shared, permanent data', 'Everyone using this app sees the same orders, and they are kept in your database.', true]
        : ['Shared, but temporary', 'Everyone sees the same orders, but the free server forgets them when it restarts or sleeps (after about 15 idle minutes). Add a free MongoDB Atlas database as MONGO_URL in Render to keep them.', false]
      : mode === 'shared'
        ? ['Shared within your organisation', 'People in your organisation who can edit this link share these orders. Friends outside it get a private copy, so send them the shared app link.', false]
        : ['Private copy', 'These orders are only in this browser. Use the shared app so everyone sees the same data.', false]
  return (
    <div className={`card storage-card ${ok ? 'ok' : 'warn'}`}>
      <h3>{title}</h3>
      <p className="muted small">{text}</p>
      {mode !== 'server' && <a className="link small" href={SHARED_APP_URL} target="_blank" rel="noopener noreferrer">Open the shared app ↗</a>}
    </div>
  )
}

/** One switch for every test shortcut. Off = only real accounts, real payments and Admin-set areas. */
function DemoModeCard() {
  const { config, refreshConfig } = useAuth()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const on = !!config?.demo_mode
  const isServer = (window as unknown as { __moonestMode?: string }).__moonestMode === 'server'
  const set = async (v: boolean) => {
    setBusy(true)
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { demo_mode: v } })
      await refreshConfig()
      toast(v ? 'Demo mode is on: testers can use the shortcuts' : 'Demo mode is off: only real accounts and real payments', 'ok')
    } catch (e) {
      toast((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={`card demo-mode ${on ? 'is-on' : ''}`}>
      <div className="row between">
        <div>
          <h3>Demo mode</h3>
          <p className="muted small">{on ? 'On for everyone using this app' : 'Off for everyone using this app'}</p>
        </div>
        <button type="button" role="switch" aria-checked={on} aria-label="Demo mode" className={`switch ${on ? 'on' : ''}`} disabled={busy} onClick={() => set(!on)}>
          <span />
        </button>
      </div>
      <ul className="demo-mode-list small">
        {on ? (
          <>
            <li>One-tap Customer and Milk agent sign-in, demo accounts (password pass1234)</li>
            <li>OTP shown on screen; test checkout instead of real payments</li>
            <li>Any pincode accepted, delivered by the demo agent</li>
            <li>"Run tomorrow's deliveries today" and the live tracking walkthrough</li>
            {isServer && <li><strong>Nothing is saved:</strong> the app runs on a temporary copy of your data. Switching demo mode off throws away everything done in demo mode, including real customers' orders</li>}
          </>
        ) : (
          <>
            <li>Demo accounts can't sign in; testers need their own accounts</li>
            <li>OTP only by SMS; online payments only with Razorpay keys (otherwise Wallet and Cash on Delivery)</li>
            <li>Only the delivery areas set up in Agents &amp; areas</li>
            {isServer && <li>Everything is saved permanently</li>}
          </>
        )}
      </ul>
    </div>
  )
}

function RunTomorrowToday({ onDone }: { onDone?: () => void }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  return (
    <div className="card demo-card">
      <h3>Try a delivery day now</h3>
      <p className="muted small">
        Orders and subscriptions start from the next delivery day, after the 10 PM cutoff. This demo button builds that day's route and puts it on
        today's agent app, so you can try start trip, live tracking, marking deliveries and cash collection right away.
      </p>
      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            const r = await api<{ created: number; skipped: number }>('/api/admin/demo/run-tomorrow-today', { method: 'POST' })
            toast(r.created ? `${r.created} stops added to today's routes. Log in as an agent to deliver.` : 'No new stops: place an order or start a subscription first.', r.created ? 'ok' : 'info')
            onDone?.()
          } catch (e) {
            toast((e as Error).message, 'bad')
          } finally {
            setBusy(false)
          }
        }}
      >
        Run tomorrow's deliveries today
      </button>
    </div>
  )
}

function RoutesTab() {
  const toast = useToast()
  const [date, setDate] = useState(todayIST())
  const stops = useApi<Stop[]>(`/api/admin/routes?date=${date}`, [date])
  const agents = useApi<{ id: string; name: string }[]>('/api/admin/agents')
  const [sel, setSel] = useState<string[]>([])
  const [agent, setAgent] = useState('')
  const name = (id?: string | null) => agents.data?.find((a) => a.id === id)?.name ?? 'Unassigned'

  const generate = async () => {
    try {
      const r = await api<{ created: number; skipped: number }>('/api/admin/routes/generate', { body: { date } })
      toast(`Generated ${r.created} stops (${r.skipped} skipped for payment issues)`, 'ok')
      stops.reload()
    } catch (e) {
      toast((e as Error).message, 'bad')
    }
  }
  const assign = async () => {
    try {
      await api('/api/admin/routes/assign', { body: { delivery_ids: sel, agent_id: agent } })
      toast('Assigned', 'ok')
      setSel([])
      stops.reload()
    } catch (e) {
      toast((e as Error).message, 'bad')
    }
  }
  return (
    <div className="stack">
      <div className="row gap wrap">
        <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        <button className="btn" onClick={generate}>Generate routes</button>
        <select className="input" value={agent} onChange={(e) => setAgent(e.target.value)}>
          <option value="">Assign selected to…</option>
          {agents.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button className="btn btn-ghost" disabled={!sel.length || !agent} onClick={assign}>Assign {sel.length || ''}</button>
      </div>
      <p className="muted small">Routes are generated automatically after the nightly cutoff. Generating again only adds new stops.</p>
      {stops.loading ? <Spinner /> : (
        <table className="table">
          <thead><tr><th /><th>Slot</th><th>Agent</th><th>#</th><th>Customer</th><th>Area</th><th>Items</th><th>Pay</th><th>Status</th></tr></thead>
          <tbody>
            {stops.data?.map((s) => (
              <tr key={s.id}>
                <td><input type="checkbox" disabled={s.status !== 'pending'} checked={sel.includes(s.id)} onChange={(e) => setSel(e.target.checked ? [...sel, s.id] : sel.filter((x) => x !== s.id))} /></td>
                <td>{s.slot}</td>
                <td className={s.agent_id ? '' : 'bad'}>{name(s.agent_id)}</td>
                <td>{s.sequence}</td>
                <td>{s.customer_name}<br /><span className="muted small">{s.customer_phone}</span></td>
                <td>{s.address.area} {s.address.pincode}</td>
                <td>{s.items.map((i) => `${i.name} × ${i.qty}`).join(', ')}</td>
                <td>{s.payment_method} {rupees(s.amount_paise)}</td>
                <td><Badge tone={{ pending: 'info', delivered: 'ok', skipped: 'muted', failed: 'bad' }[s.status]}>{s.status}</Badge></td>
              </tr>
            ))}
            {!stops.data?.length && <tr><td colSpan={9} className="muted">No stops for this date.</td></tr>}
          </tbody>
        </table>
      )}
      {SERVER_MODE && <PickupSection date={date} />}
    </div>
  )
}

/** Packets each agent collects from the dairy for the chosen day, printable. */
function PickupSection({ date }: { date: string }) {
  const { data, error } = useApi<{ date: string; estimate: boolean; agents: PickupGroup[]; total: PickupGroup }>(`/api/admin/pickup?date=${date}`, [date])
  if (error || !data) return null
  return (
    <section className="card stack-sm">
      <div className="row between wrap">
        <h2>Packet pickup list · {fmtDate(data.date)}</h2>
        <button className="btn btn-ghost btn-sm no-print" onClick={() => window.print()}>Print</button>
      </div>
      <p className="muted small estimate-note">
        {data.estimate ? 'Estimate from subscriptions and orders. It becomes final when the routes are built after the nightly cutoff.' : 'Final: from the built routes. Skipped and failed stops are left out.'}
      </p>
      {data.agents.length > 1 && <PickupList group={data.total} title="All agents" />}
      {data.agents.map((a) => <PickupList key={a.agent_id ?? 'none'} group={a} title={a.name} />)}
      {!data.agents.length && <p className="muted small">Nothing to pick up for this day.</p>}
    </section>
  )
}

/** Business charts: milk litres, revenue, deliveries and new customers per day; top brands. */
function Dashboard() {
  const [days, setDays] = useState(30)
  const { data, error, loading } = useApi<Stats>(`/api/admin/stats?days=${days}`, [days])
  const [last, setLast] = useState<Stats | null>(null)
  if (data && data !== last) setLast(data)
  const s = data ?? last
  if (error && !s) return null
  if (!s) return <Spinner />
  const pts = (f: (d: Stats['days'][number]) => number) => s.days.map((d) => ({ key: d.date, label: fmtDate(d.date, { day: 'numeric', month: 'short' }), value: f(d) }))
  const litres = (v: number) => `${+v.toFixed(1)} L`
  const count = (v: number) => String(Math.round(v))
  return (
    <section className="stack">
      <div className="row between wrap">
        <h2>Business</h2>
        <div className="dash-filters" role="group" aria-label="Period">
          {[7, 30, 90].map((n) => (
            <button key={n} className={`chip ${days === n ? 'on' : ''}`} aria-pressed={days === n} onClick={() => setDays(n)}>Last {n} days</button>
          ))}
        </div>
      </div>
      <div className={`dash-tiles${loading ? ' loading' : ''}`}>
        <div><span>Milk delivered</span><strong>{litres(s.totals.litres)}</strong></div>
        <div><span>Revenue</span><strong>{rupees(s.totals.revenue_paise)}</strong></div>
        <div><span>Deliveries</span><strong>{s.totals.delivered}</strong></div>
        <div><span>Missed / skipped</span><strong>{s.totals.missed}</strong></div>
        <div><span>New customers</span><strong>{s.totals.new_customers}</strong></div>
        <div><span>Cash owed now</span><strong>{rupees(s.totals.cash_owed_paise)}</strong></div>
      </div>
      <div className={`dash-grid${loading ? ' loading' : ''}`}>
        <ColumnChart title="Milk delivered per day" points={pts((d) => d.litres)} format={litres} />
        <ColumnChart title="Revenue per day" points={pts((d) => d.revenue_paise / 100)} format={(v) => rupees(Math.round(v * 100))} tick={(v) => `₹${v >= 1000 ? `${+(v / 1000).toFixed(1)}K` : v}`} />
        <ColumnChart title="New customers per day" points={pts((d) => d.new_customers)} format={count} whole />
        <BarList title="Milk by brand" rows={s.brands.filter((b) => b.litres > 0).map((b) => ({ label: b.brand, value: b.litres }))} format={litres} />
      </div>
    </section>
  )
}

interface Stats {
  from: string
  to: string
  days: { date: string; litres: number; revenue_paise: number; delivered: number; missed: number; new_customers: number }[]
  totals: { litres: number; revenue_paise: number; delivered: number; missed: number; new_customers: number; cash_owed_paise: number; active_subscriptions: number }
  brands: { brand: string; litres: number; revenue_paise: number }[]
}

function Fleet() {
  const { data } = useApi<Trip[]>('/api/admin/fleet')
  const pts = (data ?? []).filter((t) => t.last_location).map((t) => ({ id: t.id, lat: t.last_location!.lat, lng: t.last_location!.lng, kind: 'agent' as const, label: t.name }))
  return (
    <div className="stack">
      {pts.length ? <MapView points={pts} height={420} /> : <p className="muted">No agents sharing location right now.</p>}
      <table className="table">
        <thead><tr><th>Agent</th><th>Slot</th><th>Started</th><th>Last ping</th><th>Pending</th></tr></thead>
        <tbody>
          {data?.map((t) => (
            <tr key={t.id}><td>{t.name}<br /><span className="muted small">{t.phone}</span></td><td>{t.slot}</td><td>{fmtTime(t.started_at)}</td><td>{t.last_location ? fmtTime(t.last_location.ts) : '–'}</td><td>{t.pending ?? '–'}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Cod() {
  const toast = useToast()
  const { data, reload } = useApi<{ agents: { agent_id: string; name: string; amount_paise: number; entries: number; declared_handover_paise: number }[]; customer_dues: { user_id: string; name: string; phone: string; due_paise: number }[] }>('/api/admin/cod')
  if (!data) return <Spinner />
  return (
    <div className="stack">
      <h2>Cash with agents (unreconciled)</h2>
      <table className="table">
        <thead><tr><th>Agent</th><th>Collected (system)</th><th>Declared handover</th><th>Entries</th><th /></tr></thead>
        <tbody>
          {data.agents.map((a) => (
            <tr key={a.agent_id}>
              <td>{a.name}</td><td>{rupees(a.amount_paise)}</td>
              <td className={a.declared_handover_paise !== a.amount_paise ? 'bad' : 'ok'}>{rupees(a.declared_handover_paise)}</td>
              <td>{a.entries}</td>
              <td><button className="btn btn-sm" onClick={async (e) => { const b = e.currentTarget; b.disabled = true; try { await api(`/api/admin/cod/reconcile/${a.agent_id}`, { method: 'POST' }); toast('Reconciled', 'ok'); reload() } catch (err) { toast((err as Error).message, 'bad') } finally { b.disabled = false } }}>Mark reconciled</button></td>
            </tr>
          ))}
          {!data.agents.length && <tr><td colSpan={5} className="muted">All cash reconciled.</td></tr>}
        </tbody>
      </table>
      <h2>Customer cash dues</h2>
      <table className="table">
        <thead><tr><th>Customer</th><th>Phone</th><th>Due</th></tr></thead>
        <tbody>{data.customer_dues.map((c) => <tr key={c.user_id}><td>{c.name}</td><td>{c.phone}</td><td>{rupees(c.due_paise)}</td></tr>)}</tbody>
      </table>
    </div>
  )
}

function Catalog() {
  const toast = useToast()
  const products = useApi<Product[]>('/api/admin/products')
  const plans = useApi<Plan[]>('/api/admin/plans')
  const settings = useApi<Record<string, number> & { city: string }>('/api/admin/settings')
  const save = async (path: string, body: unknown, reload: () => void) => {
    try {
      await api(path, { method: 'PUT', body })
      toast('Saved', 'ok')
      reload()
    } catch (e) {
      toast((e as Error).message, 'bad')
    }
  }
  return (
    <div className="stack">
      <h2>Products</h2>
      <table className="table">
        <thead><tr><th>Product</th><th>Unit</th><th>Price ₹</th><th>MRP ₹</th><th>Subscribable</th><th>Active</th></tr></thead>
        <tbody>
          {products.data?.map((p) => (
            <tr key={p.id}>
              <td>{p.name}<br /><span className="muted small">{p.brand} · {p.supplier}</span></td>
              <td>{p.unit}</td>
              <td><input className="input sm" type="number" defaultValue={p.price_paise / 100} onBlur={(e) => Math.round(Number(e.target.value) * 100) !== p.price_paise && save(`/api/admin/products/${p.id}`, { price_paise: Math.round(Number(e.target.value) * 100) }, products.reload)} /></td>
              <td><input className="input sm" type="number" defaultValue={(p.mrp_paise ?? 0) / 100} onBlur={(e) => (Math.round(Number(e.target.value) * 100) || null) !== (p.mrp_paise ?? null) && save(`/api/admin/products/${p.id}`, { mrp_paise: Math.round(Number(e.target.value) * 100) || null }, products.reload)} /></td>
              <td><input type="checkbox" checked={p.subscribable} onChange={(e) => save(`/api/admin/products/${p.id}`, { subscribable: e.target.checked }, products.reload)} /></td>
              <td><input type="checkbox" checked={p.active} onChange={(e) => save(`/api/admin/products/${p.id}`, { active: e.target.checked }, products.reload)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <NewProduct onCreated={products.reload} />

      <h2>Plans</h2>
      <table className="table">
        <thead><tr><th>Plan</th><th>Description</th><th>Discount %</th><th>Perks (one per line)</th><th>Active</th></tr></thead>
        <tbody>
          {plans.data?.map((p) => (
            <tr key={p.id}>
              <td><input className="input sm" defaultValue={p.name} onBlur={(e) => e.target.value !== p.name && save(`/api/admin/plans/${p.id}`, { name: e.target.value }, plans.reload)} /></td>
              <td><input className="input" defaultValue={p.description} onBlur={(e) => e.target.value !== p.description && save(`/api/admin/plans/${p.id}`, { description: e.target.value }, plans.reload)} /></td>
              <td><input className="input sm" type="number" min={0} max={50} defaultValue={p.discount_pct} onBlur={(e) => Number(e.target.value) !== p.discount_pct && save(`/api/admin/plans/${p.id}`, { discount_pct: Number(e.target.value) }, plans.reload)} /></td>
              <td><textarea className="input" rows={3} defaultValue={p.perks.join('\n')} onBlur={(e) => { const perks = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); if (perks.join('\n') !== p.perks.join('\n')) save(`/api/admin/plans/${p.id}`, { perks }, plans.reload) }} /></td>
              <td><input type="checkbox" checked={p.active} onChange={(e) => save(`/api/admin/plans/${p.id}`, { active: e.target.checked }, plans.reload)} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Settings</h2>
      {settings.data && (
        <div className="row gap wrap">
          <label className="field">City you deliver in<input className="input sm" defaultValue={settings.data.city} onBlur={(e) => e.target.value.trim().length >= 2 && e.target.value.trim() !== settings.data!.city && save('/api/admin/settings', { city: e.target.value.trim() }, settings.reload)} /></label>
          <label className="field">Skip / order cutoff hour (previous night)<input className="input sm" type="number" min={12} max={23} defaultValue={settings.data.skip_cutoff_hour} onBlur={(e) => Number(e.target.value) !== settings.data!.skip_cutoff_hour && save('/api/admin/settings', { skip_cutoff_hour: Number(e.target.value) }, settings.reload)} /></label>
          <label className="field">Max vacation pause (days)<input className="input sm" type="number" min={1} max={90} defaultValue={settings.data.max_pause_days} onBlur={(e) => Number(e.target.value) !== settings.data!.max_pause_days && save('/api/admin/settings', { max_pause_days: Number(e.target.value) }, settings.reload)} /></label>
          <label className="field">Delivery fee ₹ (one-off)<input className="input sm" type="number" min={0} defaultValue={settings.data.delivery_fee_paise / 100} onBlur={(e) => Math.round(Number(e.target.value) * 100) !== settings.data!.delivery_fee_paise && save('/api/admin/settings', { delivery_fee_paise: Math.round(Number(e.target.value) * 100) }, settings.reload)} /></label>
          <label className="field">Free delivery above ₹<input className="input sm" type="number" min={0} defaultValue={settings.data.free_delivery_above_paise / 100} onBlur={(e) => Math.round(Number(e.target.value) * 100) !== settings.data!.free_delivery_above_paise && save('/api/admin/settings', { free_delivery_above_paise: Math.round(Number(e.target.value) * 100) }, settings.reload)} /></label>
        </div>
      )}
    </div>
  )
}

function NewProduct({ onCreated }: { onCreated: () => void }) {
  const toast = useToast()
  const empty = { name: '', brand: '', supplier: '', unit: '500 ml', price: '', image: '', category: 'milk' }
  const [f, setF] = useState(empty)
  const [busy, setBusy] = useState(false)
  return (
    <details className="card">
      <summary>+ Add product</summary>
      <div className="row gap wrap">
        {(['name', 'brand', 'supplier', 'unit', 'price', 'image'] as const).map((k) => (
          <input key={k} className="input" placeholder={k === 'price' ? 'Price ₹' : k} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
        ))}
        <select className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="milk">Milk</option><option value="dairy">Dairy</option></select>
        <button className="btn" disabled={busy || !f.name || !Number(f.price)} onClick={async () => {
          setBusy(true)
          try {
            await api('/api/admin/products', { body: { name: f.name, brand: f.brand, supplier: f.supplier, unit: f.unit, category: f.category, image: f.image, price_paise: Math.round(Number(f.price) * 100) } })
            toast('Product added', 'ok')
            setF(empty)
            onCreated()
          } catch (e) {
            toast((e as Error).message, 'bad')
          } finally {
            setBusy(false)
          }
        }}>{busy ? 'Adding…' : 'Create'}</button>
      </div>
    </details>
  )
}

function Subs() {
  const toast = useToast()
  const { data, reload } = useApi<(Subscription & { customer: { name: string; phone: string }; product_name: string })[]>('/api/admin/subscriptions')
  if (!data) return <Spinner />
  return (
    <table className="table">
      <thead><tr><th>Customer</th><th>Product</th><th>Plan</th><th>Slot</th><th>Pay</th><th>Status</th><th /></tr></thead>
      <tbody>
        {data.map((s) => (
          <tr key={s.id}>
            <td>{s.customer.name}<br /><span className="muted small">{s.customer.phone}</span></td>
            <td>{s.product_name} × {s.quantity}</td>
            <td>{s.plan_code}</td><td>{s.slot}</td><td>{s.payment_method}</td>
            <td><Badge tone={s.status === 'active' ? 'ok' : 'warn'}>{s.status}</Badge></td>
            <td>{['active', 'paused'].includes(s.status) && <button className="btn btn-ghost btn-sm" onClick={async (e) => { const b = e.currentTarget; b.disabled = true; try { await api(`/api/admin/subscriptions/${s.id}/toggle-pause`, { method: 'POST' }); toast('Updated', 'ok'); reload() } catch (err) { toast((err as Error).message, 'bad') } finally { b.disabled = false } }}>{s.status === 'active' ? 'Pause' : 'Unpause'}</button>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Customers() {
  const toast = useToast()
  const [q, setQ] = useState('')
  const { data, reload } = useApi<{ id: string; name: string; phone: string; email: string; wallet_paise: number; cod_due_paise: number }[]>(`/api/admin/customers?q=${encodeURIComponent(q)}`, [q])
  const [refundFor, setRefundFor] = useState<string | null>(null)
  const [amt, setAmt] = useState('')
  const [reason, setReason] = useState('Goodwill credit')
  const refund = async (id: string) => {
    try {
      await api(`/api/admin/customers/${id}/refund`, { body: { amount_paise: Math.round(Number(amt) * 100), reason } })
      toast('Refund issued to wallet', 'ok')
      setRefundFor(null)
      setAmt('')
      reload()
    } catch (e) {
      toast((e as Error).message, 'bad')
    }
  }
  return (
    <div className="stack">
      <input className="input" placeholder="Search name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
      <table className="table">
        <thead><tr><th>Name</th><th>Phone</th><th>Wallet</th><th>Cash due</th><th /></tr></thead>
        <tbody>{data?.map((c) => (
          <tr key={c.id}><td>{c.name || '–'}</td><td>{c.phone || c.email}</td><td>{rupees(c.wallet_paise)}</td><td>{rupees(c.cod_due_paise)}</td><td>
            {refundFor === c.id ? (
              <div className="row gap wrap">
                <input className="input sm" type="number" min={1} placeholder="₹" value={amt} onChange={(e) => setAmt(e.target.value)} aria-label="Refund amount in rupees" />
                <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
                <button className="btn btn-sm" disabled={!(Number(amt) > 0) || reason.trim().length < 2} onClick={() => refund(c.id)}>Credit wallet</button>
                <button className="link-btn" onClick={() => setRefundFor(null)}>Cancel</button>
              </div>
            ) : (
              <button className="btn btn-ghost btn-sm" onClick={() => setRefundFor(c.id)}>Refund</button>
            )}
          </td></tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function Agents() {
  const toast = useToast()
  const agents = useApi<{ id: string; name: string; phone: string; email?: string; has_password?: boolean; pincodes: string[] }[]>('/api/admin/agents')
  const [pw, setPw] = useState<{ id: string; email: string; password: string } | null>(null)
  const areas = useApi<{ pincode: string; name: string; active: boolean }[]>('/api/admin/areas')
  const [f, setF] = useState({ name: '', phone: '', pincodes: '', email: '', password: '' })
  const [area, setArea] = useState({ pincode: '', name: '', lat: '', lng: '' })
  const call = async (fn: () => Promise<unknown>, reload: () => void) => {
    try {
      await fn()
      toast('Saved', 'ok')
      reload()
    } catch (e) {
      toast((e as Error).message, 'bad')
    }
  }
  return (
    <div className="stack">
      <h2>Milk agents</h2>
      <table className="table fill">
        <thead><tr><th>Name</th><th>Phone</th><th>Pincodes served</th><th>Sign-in</th></tr></thead>
        <tbody>{agents.data?.map((a) => (
          <tr key={a.id}>
            <td>{a.name}</td><td>{a.phone}</td>
            <td><input className="input" defaultValue={a.pincodes.join(', ')} onBlur={(e) => e.target.value.split(/[,\s]+/).filter(Boolean).join(',') !== a.pincodes.join(',') && call(() => api(`/api/admin/agents/${a.id}`, { method: 'PUT', body: { name: a.name, phone: a.phone, pincodes: e.target.value.split(/[,\s]+/).filter(Boolean) } }), agents.reload)} /></td>
            <td>
              {pw?.id === a.id ? (
                <div className="row gap wrap">
                  <input className="input sm" type="email" placeholder="Email" value={pw.email} onChange={(e) => setPw({ ...pw, email: e.target.value })} />
                  <input className="input sm" type="text" placeholder="Password (6+)" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} />
                  <button className="btn btn-sm" disabled={!pw.email || pw.password.length < 6} onClick={() => call(() => api(`/api/admin/agents/${a.id}/password`, { body: { email: pw.email, password: pw.password } }), () => { setPw(null); agents.reload() })}>Save</button>
                </div>
              ) : (
                <span className="row gap">
                  <span className="muted small">{a.has_password ? a.email : 'OTP only'}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setPw({ id: a.id, email: a.email ?? '', password: '' })}>{a.has_password ? 'Change password' : 'Set password'}</button>
                </span>
              )}
            </td>
          </tr>
        ))}</tbody>
      </table>
      <div className="row gap wrap">
        <input className="input" placeholder="Agent name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input className="input" placeholder="10-digit mobile" inputMode="numeric" maxLength={10} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value.replace(/\D/g, '').slice(0, 10) })} />
        <input className="input" placeholder="Pincodes (comma separated)" value={f.pincodes} onChange={(e) => setF({ ...f, pincodes: e.target.value })} />
        <input className="input" type="email" placeholder="Email for sign-in" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <input className="input" type="text" placeholder="Password (6+ characters)" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <button className="btn" disabled={!f.name || f.phone.length !== 10 || (!!f.password && (f.password.length < 6 || !f.email))} onClick={() => call(() => api('/api/admin/agents', { body: { name: f.name, phone: f.phone, pincodes: f.pincodes.split(/[,\s]+/).filter(Boolean), email: f.email || undefined, password: f.password || undefined } }), () => { setF({ name: '', phone: '', pincodes: '', email: '', password: '' }); agents.reload() })}>Onboard agent</button>
      </div>
      <p className="muted small">With an email and password the agent signs in on the Milk Agent tab without OTP, which also works when demo mode is off and SMS isn't set up.</p>

      <h2>Serviceable areas</h2>
      <table className="table fill">
        <thead><tr><th>Pincode</th><th>Area</th><th>Status</th><th /></tr></thead>
        <tbody>{areas.data?.map((a) => (
          <tr key={a.pincode}><td>{a.pincode}</td><td>{a.name}</td><td>{a.active ? <Badge tone="ok">Live</Badge> : <Badge>Off</Badge>}</td>
            <td><button className="btn btn-ghost btn-sm" onClick={() => call(() => api(`/api/admin/areas/${a.pincode}/toggle`, { method: 'POST' }), areas.reload)}>{a.active ? 'Disable' : 'Enable'}</button></td></tr>
        ))}</tbody>
      </table>
      <div className="row gap wrap">
        <input className="input sm" placeholder="Pincode" maxLength={6} value={area.pincode} onChange={(e) => setArea({ ...area, pincode: e.target.value.replace(/\D/g, '') })} />
        <input className="input" placeholder="Area name" value={area.name} onChange={(e) => setArea({ ...area, name: e.target.value })} />
        <input className="input sm" placeholder="Lat (optional)" value={area.lat} onChange={(e) => setArea({ ...area, lat: e.target.value })} />
        <input className="input sm" placeholder="Lng (optional)" value={area.lng} onChange={(e) => setArea({ ...area, lng: e.target.value })} />
        <button className="btn" disabled={area.pincode.length !== 6 || !area.name} onClick={() => call(() => api('/api/admin/areas', { body: { pincode: area.pincode, name: area.name, ...(area.lat.trim() && area.lng.trim() ? { lat: Number(area.lat), lng: Number(area.lng) } : {}) } }), areas.reload)}>Add area</button>
      </div>
    </div>
  )
}
