import { useState } from 'react'
import { IconCheck } from '../../components/icons'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api, assetUrl } from '../../api'
import { usePay } from '../../components/payments'
import { Badge, ConfirmButton, Empty, ErrorBox, Spinner } from '../../components/ui'
import { fmtDate, fmtTime, ORDER_STATUS, PAYMENT_LABEL, rupees } from '../../lib'
import { useApi, useAuth, useToast } from '../../state'
import type { Order, PaymentIntent } from '../../types'

const PAY_STATUS: Record<string, string> = {
  pending: 'Payment pending', paid: 'Paid', failed: 'Payment failed', cod_pending: 'Pay on delivery',
  refunded_to_wallet: 'Refunded to wallet',
}

export function Orders() {
  const { data, error, loading, reload } = useApi<Order[]>('/api/orders')
  if (loading) return <Spinner />
  if (error) return <ErrorBox message={error} onRetry={reload} />
  if (!data?.length)
    return <Empty title="No orders yet" action={<Link to="/shop" className="btn">Start shopping</Link>}>Your one-time orders will appear here.</Empty>
  return (
    <div className="stack">
      <h1>My orders</h1>
      {data.map((o) => {
        const st = ORDER_STATUS[o.status] ?? { label: o.status, tone: 'muted' }
        return (
          <Link key={o.id} to={`/orders/${o.id}`} className="card">
            <div className="row between">
              <strong>#{o.number}</strong>
              <Badge tone={st.tone}>{st.label}</Badge>
            </div>
            <p className="muted small">{o.items.map((i) => `${i.name} × ${i.qty}`).join(', ')}</p>
            <div className="row between small">
              <span>{fmtDate(o.delivery_date)} · {o.slot === 'morning' ? '5:30 AM' : '5:00 PM'}</span>
              <strong>{rupees(o.total_paise)}</strong>
            </div>
          </Link>
        )
      })}
    </div>
  )
}

const STEPS = ['confirmed', 'out_for_delivery', 'delivered']

export function OrderDetail() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const { data: o, error, loading, reload } = useApi<Order>(`/api/orders/${id}`)
  const pay = usePay()
  const toast = useToast()
  const { refresh } = useAuth()
  const [busy, setBusy] = useState(false)
  if (loading) return <Spinner />
  if (error || !o) return <ErrorBox message={error ?? 'Order not found'} onRetry={reload} />
  const st = ORDER_STATUS[o.status] ?? { label: o.status, tone: 'muted' }
  const stepIdx = o.status === 'delivered' ? 2 : o.delivery ? 1 : o.status === 'confirmed' ? 0 : -1

  const retry = async () => {
    setBusy(true)
    try {
      const intent = await api<PaymentIntent>(`/api/orders/${o.id}/retry-payment`, { method: 'POST' })
      const r = await pay(intent, `Order ${o.number}`)
      toast(r.status === 'paid' ? 'Payment successful, order confirmed!' : r.message ?? 'Payment not completed', r.status === 'paid' ? 'ok' : 'bad')
      reload()
    } catch (e) {
      toast((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }
  const cancel = async () => {
    setBusy(true)
    try {
      await api(`/api/orders/${o.id}/cancel`, { method: 'POST' })
      toast('Order cancelled', 'ok')
      refresh()
      reload()
    } catch (e) {
      toast((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      {params.get('new') && o.status === 'confirmed' && (
        <div className="card success-card">
          <div className="big-check" aria-hidden><IconCheck size={30} /></div>
          <h2>Order placed!</h2>
          <p>
            Order <strong>#{o.number}</strong> arrives {fmtDate(o.delivery_date)}, {o.slot === 'morning' ? '5:30 AM' : '5:00 PM'}.
          </p>
        </div>
      )}
      <div className="row between">
        <h1>#{o.number}</h1>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>

      {o.status !== 'cancelled' && o.status !== 'pending' && o.status !== 'failed' && (
        <ol className="progress">
          {STEPS.map((s, i) => (
            <li key={s} className={i <= stepIdx ? 'done' : ''}>{ORDER_STATUS[s].label}</li>
          ))}
        </ol>
      )}
      {o.rescheduled && <p className="notice">We missed your earlier delivery. Rescheduled to {fmtDate(o.delivery_date)}.</p>}
      {o.status === 'failed' && <p className="notice bad">Delivery missed: {o.failure_reason}</p>}

      {o.status === 'pending' && (
        <div className="card warn-card">
          <p>Payment not completed. Your order is reserved until you pay.</p>
          <button className="btn" disabled={busy} onClick={retry}>Pay {rupees(o.total_paise)}</button>
        </div>
      )}

      {o.delivery?.photo_url && (
        <div className="card">
          <h3>Delivery proof</h3>
          <img className="proof" src={assetUrl(o.delivery.photo_url)} alt="Delivery proof" />
          {o.delivery.delivered_at && <p className="muted small">Delivered at {fmtTime(o.delivery.delivered_at)}</p>}
        </div>
      )}

      <section className="card">
        {o.items.map((i) => (
          <div key={i.product_id} className="row between">
            <span>{i.name} ({i.unit}) × {i.qty}</span>
            <span>{rupees(i.price_paise * i.qty)}</span>
          </div>
        ))}
        <hr />
        <div className="row between"><span>Delivery fee</span><span>{o.delivery_fee_paise ? rupees(o.delivery_fee_paise) : 'FREE'}</span></div>
        <div className="row between total"><strong>Total</strong><strong>{rupees(o.total_paise)}</strong></div>
        <p className="muted small">{PAYMENT_LABEL[o.payment_method]} · {PAY_STATUS[o.payment_status] ?? o.payment_status}</p>
      </section>

      <section className="card">
        <h3>Delivery</h3>
        <p>{fmtDate(o.delivery_date, { weekday: 'long', day: 'numeric', month: 'long' })}, {o.slot === 'morning' ? '5:30 AM' : '5:00 PM'}</p>
        <p className="muted small">{o.address.label}: {[o.address.line1, o.address.line2, o.address.area, o.address.pincode].filter(Boolean).join(', ')}</p>
      </section>

      <div className="row gap">
        <Link to="/orders" className="btn btn-ghost">All orders</Link>
        {o.can_cancel && <ConfirmButton disabled={busy} onConfirm={cancel}>Cancel order</ConfirmButton>}
      </div>
    </div>
  )
}
