import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { SERVER_MODE } from '../../api'
import PushCard from '../../components/PushCard'
import { groupProducts, Item, ProductSheet } from '../../components/catalog'
import { IconArrowRight, IconPin, IconRepeat, IconTruck } from '../../components/icons'
import ProductArt from '../../components/ProductArt'
import { Badge, Spinner, useGreeting } from '../../components/ui'
import { firstName, fmtDate, greetingFor, rupees, todayIST } from '../../lib'
import { useApi, useAuth, useCart } from '../../state'
import { ShelfCard } from './Shop'
import type { Address, Product, Subscription, Tracking } from '../../types'

/** One line that follows the customer's day: on the way, delivered, paused, next delivery. */
function statusLine(track: Tracking[] | null, subs: Subscription[] | null): string | null {
  const live = track?.find((t) => t.status === 'pending' && t.trip_status === 'active')
  if (live) return live.eta_minutes ? `Your milk is on the way, arriving in ~${live.eta_minutes} min` : 'Your milk is on the way'
  if (track?.some((t) => t.status === 'delivered')) return "Today's milk has been delivered"
  const pending = track?.find((t) => t.status === 'pending')
  if (pending) return `Your milk arrives today at ${pending.slot === 'morning' ? '5:30 AM' : '5:00 PM'}`
  const active = subs?.filter((s) => s.status === 'active') ?? []
  const paused = active.find((s) => s.display_status === 'paused')
  if (paused) {
    const p = paused.pauses.find((x) => x.start_date <= todayIST() && x.end_date >= todayIST())
    return p ? `Subscription paused until ${fmtDate(p.end_date)}` : 'Subscription paused'
  }
  const next = active
    .flatMap((s) => s.upcoming.filter((u) => u.state === 'scheduled').map((u) => ({ ...u, slot: s.slot_label })))
    .sort((a, b) => a.date.localeCompare(b.date))[0]
  return next ? `Next delivery ${fmtDate(next.date)}, ${next.slot}` : null
}

export default function Home() {
  const { user, config } = useAuth()
  const g = useGreeting()
  const nav = useNavigate()
  const cart = useCart()
  const [open, setOpen] = useState<{ item: Item; initial: string } | null>(null)
  const track = useApi<Tracking[]>('/api/tracking/today')
  const subs = useApi<Subscription[]>('/api/subscriptions')
  const products = useApi<Product[]>('/api/products')
  const addrs = useApi<Address[]>('/api/addresses')
  const live = track.data?.find((t) => t.status === 'pending' && t.trip_status === 'active')
  const activeSubs = subs.data?.filter((s) => s.status !== 'cancelled') ?? []
  const addr = addrs.data?.find((a) => a.is_default) ?? addrs.data?.[0]
  const slot = activeSubs[0]?.slot_label ?? '5:30 AM'
  const status = statusLine(track.data, subs.data)
  const name = firstName(user?.name) || 'there'

  return (
    <div className="stack home">
      <section className="hello">
        <p className="greet-line">{greetingFor(g.hour)},</p>
        <h1 className="display-md">
          {name}
        </h1>
        {addr ? (
          <p className="muted small inline-icon">
            <IconPin size={15} /> Delivering to {addr.area ?? addr.line2} · {slot} slot
          </p>
        ) : addrs.data && (
          <Link to="/account" className="link small inline-icon">
            <IconPin size={15} /> Add your delivery address
          </Link>
        )}
      </section>

      {live ? (
        <Link to="/track" className="card status-card live">
          <span className="status-icon"><IconTruck size={20} /></span>
          <div className="grow">
            <strong>{live.agent?.name ?? 'Your milk agent'} is on the way</strong>
            <p className="muted small">{live.eta_minutes ? `Arriving in ~${live.eta_minutes} min` : 'Calculating ETA…'} · {live.stops_before_you} stops before you</p>
          </div>
          <Badge tone="ok">Live</Badge>
        </Link>
      ) : (
        status && (
          <Link to={track.data?.length ? '/track' : '/subscriptions'} className="card status-card">
            <span className="status-icon"><IconRepeat size={20} /></span>
            <p className="grow">{status}</p>
            <IconArrowRight size={18} />
          </Link>
        )
      )}

      {SERVER_MODE && (activeSubs.length > 0 || !!track.data?.length) && <PushCard nudge />}

      {!live && config?.demo_mode && (
        <Link to="/live-demo" className="card demo-cta">
          <span className="status-icon"><IconTruck size={20} /></span>
          <div className="grow">
            <strong>See live tracking in action</strong>
            <p className="muted small">Watch a milk agent's morning run, stop by stop</p>
          </div>
          <IconArrowRight size={18} />
        </Link>
      )}

      <section className="promo promo-photo">
        <div className="promo-copy">
          <span className="tag-yellow">4 trusted brands</span>
          <h2 className="display-xs">Aavin, Arokya, Heritage &amp; Amul at your door</h2>
          <p>Milk, curd, paneer &amp; ghee · delivered by 5:30 AM</p>
          <button className="btn btn-white" onClick={() => nav('/shop')}>Shop milk</button>
        </div>
        <span className="promo-ring" aria-hidden />
        <span className="promo-dot" aria-hidden />
      </section>

      <section className="stack-sm">
        <span className="eyebrow">Brands we deliver</span>
        <div className="brand-strip">
          {[...new Set((products.data ?? []).map((p) => p.brand))].map((b) => (
            <Link key={b} to={`/shop?brand=${encodeURIComponent(b)}`} className="brand-pill">{b}</Link>
          ))}
        </div>
      </section>

      <section className="stack-sm">
        <div className="row between">
          <div>
            <span className="eyebrow">Fresh this morning</span>
            <h2 className="display-xs">Today's shelf</h2>
          </div>
          <Link to="/shop" className="link small">See all</Link>
        </div>
        {products.loading ? (
          <Spinner />
        ) : (
          <div className="shelf">
            {groupProducts((products.data ?? []).filter((p) => p.category !== 'dairy')).slice(0, 6).map((it) => (
              <ShelfCard key={it.key} it={it} onOpen={(initial) => setOpen({ item: it, initial })} />
            ))}
          </div>
        )}
      </section>

      {products.data?.some((p) => p.category === 'dairy') && (
        <section className="stack-sm">
          <div className="row between">
            <div>
              <span className="eyebrow">Add to tomorrow's drop</span>
              <h2 className="display-xs">Dairy essentials</h2>
            </div>
            <Link to="/shop?cat=dairy" className="link small">See all</Link>
          </div>
          <div className="shelf">
            {groupProducts(products.data.filter((p) => p.category === 'dairy')).slice(0, 4).map((it) => (
              <ShelfCard key={it.key} it={it} onOpen={(initial) => setOpen({ item: it, initial })} />
            ))}
          </div>
        </section>
      )}

      <section className="stack-sm">
        <div className="row between">
          <div>
            <span className="eyebrow">Your rituals</span>
            <h2 className="display-xs">Subscriptions</h2>
          </div>
          <Link to="/plans" className="link small">New plan</Link>
        </div>
        {subs.loading ? null : activeSubs.length ? (
          activeSubs.slice(0, 3).map((s) => (
            <Link key={s.id} to={`/subscriptions/${s.id}`} className="card list-card">
              <ProductArt p={s.product} className="list-thumb" />
              <div className="grow">
                <strong>{s.product?.brand && s.product.brand !== 'MooNest Farms' ? `${s.product.brand} ` : ''}{s.product?.name}{s.product?.pack_label ? ` · ${s.product.pack_label}` : ''}</strong>
                <p className="muted small">{s.quantity} × {s.plan?.name} · {s.slot_label} · {rupees(s.per_delivery_paise)}</p>
              </div>
              <Badge tone={s.display_status === 'active' ? 'ok' : 'warn'}>{s.display_status.replace('_', ' ')}</Badge>
            </Link>
          ))
        ) : (
          <Link to="/plans" className="card empty-card">
            <strong>No subscription yet</strong>
            <p className="muted small">Daily, alternate-day or custom days. Skip any day before 10 PM.</p>
          </Link>
        )}
      </section>

      {open && <ProductSheet item={open.item} initial={open.initial} onClose={() => setOpen(null)} />}
      {cart.count > 0 && (
        <Link to="/cart" className="cart-bar">
          <span>{cart.count} item{cart.count > 1 ? 's' : ''} · {rupees(cart.subtotal)}</span>
          <strong className="inline-icon">Checkout <IconArrowRight size={18} /></strong>
        </Link>
      )}
    </div>
  )
}
