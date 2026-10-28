import { useEffect, useState } from 'react'
import { IconSunrise, IconSunset } from '../../components/icons'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { usePay } from '../../components/payments'
import ProductArt from '../../components/ProductArt'
import { Empty, Spinner } from '../../components/ui'
import { addDays, fmtDate, PAYMENT_LABEL, rupees } from '../../lib'
import { useApi, useAuth, useCart, useToast } from '../../state'
import type { Address, Order, PaymentIntent, Slot } from '../../types'
import { AddressPicker } from './AddressPicker'

type Method = 'razorpay' | 'wallet' | 'cod'

export default function Checkout() {
  const cart = useCart()
  const { config, user, refresh } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const pay = usePay()
  const addrs = useApi<Address[]>('/api/addresses')
  const [addressId, setAddressId] = useState('')
  const [slot, setSlot] = useState<Slot>('morning')
  const [date, setDate] = useState('')
  const [method, setMethod] = useState<Method>('cod')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (config && !date) setDate(config.next_cycle_date)
  }, [config, date])
  useEffect(() => {
    if (addrs.data && !addressId) setAddressId((addrs.data.find((a) => a.is_default) ?? addrs.data[0])?.id ?? '')
  }, [addrs.data, addressId])

  if (!cart.lines.length)
    return (
      <Empty title="Your cart is empty" action={<Link to="/shop" className="btn">Browse milk & dairy</Link>}>
        Add fresh milk, curd or ghee for a one-time delivery.
      </Empty>
    )
  if (!config || addrs.loading) return <Spinner />

  const fee = cart.subtotal >= config.free_delivery_above_paise ? 0 : config.delivery_fee_paise
  const total = cart.subtotal + fee
  const dates = Array.from({ length: 7 }, (_, i) => addDays(config.next_cycle_date, i))
  const walletShort = method === 'wallet' && (user?.wallet_paise ?? 0) < total
  const onlineDisabled = config.payments_mode === 'disabled'

  const place = async () => {
    setErr('')
    if (!addressId) return setErr('Please choose a delivery address')
    setBusy(true)
    try {
      const r = await api<{ order: Order; payment?: PaymentIntent }>('/api/orders', {
        body: {
          items: cart.lines.map((l) => ({ product_id: l.product.id, qty: l.qty })),
          address_id: addressId, slot, delivery_date: date, payment_method: method, note,
        },
      })
      if (r.payment) {
        const res = await pay(r.payment, `Order ${r.order.number}`)
        if (res.status !== 'paid') {
          cart.clear()
          toast(res.message ?? 'Payment not completed. You can retry from the order page.', 'bad')
          return nav(`/orders/${r.order.id}`)
        }
      }
      cart.clear()
      refresh()
      nav(`/orders/${r.order.id}?new=1`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <h1>Checkout</h1>

      <section className="card">
        <h3>Items</h3>
        {cart.lines.map((l) => (
          <div key={l.product.id} className="line">
            <ProductArt p={l.product} className="line-art" />
            <div className="grow">
              <strong>{l.product.brand !== 'MooNest Farms' ? `${l.product.brand} ` : ''}{l.product.name}</strong>
              {l.product.pack_label && <span className="pack-tag"><i style={{ background: l.product.pack_color }} />{l.product.pack_label} packet</span>}
              <p className="muted small">{l.product.unit} · {rupees(l.product.price_paise)}</p>
            </div>
            <div className="stepper">
              <button onClick={() => cart.setQty(l.product.id, l.qty - 1)} aria-label="Decrease">−</button>
              <span>{l.qty}</span>
              <button onClick={() => cart.setQty(l.product.id, l.qty + 1)} aria-label="Increase">+</button>
            </div>
            <strong className="amt">{rupees(l.qty * l.product.price_paise)}</strong>
          </div>
        ))}
      </section>

      <section className="card">
        <h3>Deliver to</h3>
        <AddressPicker addresses={addrs.data ?? []} value={addressId} onChange={setAddressId} onAdded={() => addrs.reload()} />
      </section>

      <section className="card">
        <h3>Delivery slot</h3>
        <div className="h-scroll dates">
          {dates.map((d) => (
            <button key={d} className={`date-chip ${date === d ? 'on' : ''}`} onClick={() => setDate(d)}>
              <span>{fmtDate(d, { weekday: 'short' })}</span>
              <strong>{fmtDate(d, { day: 'numeric' })}</strong>
              <span>{fmtDate(d, { month: 'short' })}</span>
            </button>
          ))}
        </div>
        <div className="segmented">
          {config.slots.map((s) => (
            <button key={s.code} className={slot === s.code ? 'on' : ''} onClick={() => setSlot(s.code)}>
              {s.code === 'morning' ? <IconSunrise size={17} /> : <IconSunset size={17} />} {s.label}
            </button>
          ))}
        </div>
        <p className="muted small">Orders close at {config.skip_cutoff_hour}:00 the night before delivery.</p>
      </section>

      <section className="card">
        <h3>Payment</h3>
        {(['razorpay', 'wallet', 'cod'] as Method[]).map((m) => (
          <label key={m} className={`option ${method === m ? 'on' : ''} ${m === 'razorpay' && onlineDisabled ? 'disabled' : ''}`}>
            <input type="radio" name="pay" checked={method === m} disabled={m === 'razorpay' && onlineDisabled} onChange={() => setMethod(m)} />
            <div>
              <strong>{PAYMENT_LABEL[m]}</strong>
              <p className="muted small">
                {m === 'razorpay' && (onlineDisabled ? 'Online payments are not configured yet' : 'GPay, PhonePe, Paytm, BHIM, any bank or card')}
                {m === 'wallet' && `Balance ${rupees(user?.wallet_paise)}`}
                {m === 'cod' && 'Pay the milk agent in cash'}
              </p>
            </div>
          </label>
        ))}
        {walletShort && (
          <p className="error">
            Wallet balance is low. <Link to="/wallet">Top up</Link> or pick another method.
          </p>
        )}
        <input className="input" placeholder="Note for the milk agent (optional)" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
      </section>

      <section className="card summary">
        <div className="row between"><span>Subtotal</span><span>{rupees(cart.subtotal)}</span></div>
        <div className="row between">
          <span>Delivery fee</span>
          <span>{fee ? rupees(fee) : <span className="ok">FREE</span>}</span>
        </div>
        {fee > 0 && <p className="muted small">Free delivery above {rupees(config.free_delivery_above_paise)}</p>}
        <div className="row between total"><strong>Total</strong><strong>{rupees(total)}</strong></div>
      </section>

      {err && <p className="error">{err}</p>}
      <button className="btn btn-block btn-lg sticky-cta" disabled={busy || walletShort || !addressId} onClick={place}>
        {busy ? 'Placing order…' : `Place order · ${rupees(total)}`}
      </button>
    </div>
  )
}
