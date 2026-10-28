import { useEffect, useState } from 'react'
import { IconSunrise, IconSunset } from '../../components/icons'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../../api'
import { usePay } from '../../components/payments'
import { groupProducts, PackDots, PackPicker } from '../../components/catalog'
import ProductArt from '../../components/ProductArt'
import { Spinner } from '../../components/ui'
import { addDays, DAY_NAMES, fmtDate, PAYMENT_LABEL, rupees } from '../../lib'
import { useApi, useAuth, useToast } from '../../state'
import type { Address, PaymentIntent, Plan, Product, Slot, Subscription } from '../../types'
import { AddressPicker } from './AddressPicker'

type SubPay = 'autopay' | 'wallet' | 'cod'
const PER_MONTH: Record<Plan['code'], number> = { daily: 30, alternate: 15, custom: 0 }

export default function Subscribe() {
  const [params] = useSearchParams()
  const nav = useNavigate()
  const toast = useToast()
  const pay = usePay()
  const { config, user, refresh } = useAuth()
  const products = useApi<Product[]>('/api/products')
  const plans = useApi<Plan[]>('/api/plans')
  const addrs = useApi<Address[]>('/api/addresses')

  const [productId, setProductId] = useState(params.get('product') ?? '')
  const [qty, setQty] = useState(1)
  const [slot, setSlot] = useState<Slot>('morning')
  const [planCode, setPlanCode] = useState<Plan['code']>((params.get('plan') as Plan['code']) || 'daily')
  const [days, setDays] = useState<number[]>([0, 2, 4])
  const [start, setStart] = useState('')
  const [addressId, setAddressId] = useState('')
  const [method, setMethod] = useState<SubPay>('autopay')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const subscribable = products.data?.filter((p) => p.subscribable) ?? []
  useEffect(() => {
    if (!productId && subscribable.length) setProductId(subscribable[0].id)
  }, [subscribable, productId])
  useEffect(() => {
    if (config && !start) setStart(config.next_cycle_date)
  }, [config, start])
  useEffect(() => {
    if (addrs.data && !addressId) setAddressId((addrs.data.find((a) => a.is_default) ?? addrs.data[0])?.id ?? '')
  }, [addrs.data, addressId])
  useEffect(() => {
    if (config?.payments_mode === 'disabled' && method === 'autopay') setMethod('cod') // the wallet can't be topped up either
  }, [config, method])

  if (products.loading || plans.loading || addrs.loading || !config) return <Spinner />
  const product = subscribable.find((p) => p.id === productId)
  const plan = plans.data?.find((p) => p.code === planCode)
  const unit = product && plan ? Math.round((product.price_paise * (100 - plan.discount_pct)) / 100) : 0
  const perDelivery = unit * qty
  const perMonth = perDelivery * (planCode === 'custom' ? Math.round((days.length * 30) / 7) : PER_MONTH[planCode])
  const starts = Array.from({ length: 10 }, (_, i) => addDays(config.next_cycle_date, i))

  const submit = async () => {
    setErr('')
    if (!addressId) return setErr('Please add a delivery address')
    if (planCode === 'custom' && !days.length) return setErr('Pick at least one delivery day')
    setBusy(true)
    try {
      const r = await api<{ subscription: Subscription; payment?: PaymentIntent }>('/api/subscriptions', {
        body: { product_id: productId, quantity: qty, plan_code: planCode, custom_days: planCode === 'custom' ? days : [], slot, start_date: start, address_id: addressId, payment_method: method },
      })
      if (r.payment) {
        const res = await pay(r.payment, 'UPI AutoPay mandate for MooNest subscription')
        if (res.status !== 'paid') {
          toast(res.message ?? 'AutoPay not set up. You can retry from the subscription page.', 'bad')
          return nav(`/subscriptions/${r.subscription.id}`)
        }
      }
      toast('Subscription started', 'ok')
      refresh()
      nav(`/subscriptions/${r.subscription.id}`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <h1>Start a subscription</h1>

      <section className="card">
        <h3>1. Product</h3>
        <div className="stack-sm">
          {groupProducts(subscribable).map((it) => {
            const chosen = it.variants.find((v) => v.id === productId)
            const shown = chosen ?? it.variants[0]
            return (
              <div key={it.key} className={`option sub-item ${chosen ? 'on' : ''}`} onClick={() => !chosen && setProductId(it.variants[0].id)}>
                <ProductArt p={shown} className="thumb" />
                <div className="grow">
                  <span className="brand-line">{it.brand}</span>
                  <strong>{it.variants.length > 1 ? `${shown.name}` : shown.name} · {shown.unit}</strong>
                  {chosen && <PackPicker variants={it.variants} value={productId} onChange={setProductId} size="sm" />}
                  {!chosen && <PackDots variants={it.variants} />}
                </div>
                <strong>{rupees(shown.price_paise)}</strong>
              </div>
            )
          })}
        </div>
        <div className="row between">
          <span>Quantity per delivery</span>
          <div className="stepper">
            <button onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Decrease">−</button>
            <span>{qty}</span>
            <button onClick={() => setQty(Math.min(10, qty + 1))} aria-label="Increase">+</button>
          </div>
        </div>
      </section>

      <section className="card">
        <h3>2. Slot</h3>
        <div className="segmented">
          {config.slots.map((s) => (
            <button key={s.code} className={slot === s.code ? 'on' : ''} onClick={() => setSlot(s.code)}>
              {s.code === 'morning' ? <IconSunrise size={17} /> : <IconSunset size={17} />} {s.label}
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>3. Plan</h3>
        <div className="segmented">
          {plans.data?.map((p) => (
            <button key={p.code} className={planCode === p.code ? 'on' : ''} onClick={() => setPlanCode(p.code)}>
              {p.name}
              {p.discount_pct > 0 && <small> −{p.discount_pct}%</small>}
            </button>
          ))}
        </div>
        {planCode === 'custom' && (
          <div className="days">
            {DAY_NAMES.map((d, i) => (
              <button key={d} className={`day ${days.includes(i) ? 'on' : ''}`} onClick={() => setDays(days.includes(i) ? days.filter((x) => x !== i) : [...days, i].sort())}>
                {d}
              </button>
            ))}
          </div>
        )}
        <p className="muted small">Starts on</p>
        <div className="h-scroll dates">
          {starts.map((d) => (
            <button key={d} className={`date-chip ${start === d ? 'on' : ''}`} onClick={() => setStart(d)}>
              <span>{fmtDate(d, { weekday: 'short' })}</span>
              <strong>{fmtDate(d, { day: 'numeric' })}</strong>
              <span>{fmtDate(d, { month: 'short' })}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="card">
        <h3>4. Address</h3>
        <AddressPicker addresses={addrs.data ?? []} value={addressId} onChange={setAddressId} onAdded={() => addrs.reload()} />
      </section>

      <section className="card">
        <h3>5. Payment</h3>
        {(['autopay', 'wallet', 'cod'] as SubPay[]).map((m) => {
          const disabled = m === 'autopay' && config.payments_mode === 'disabled'
          return (
            <label key={m} className={`option ${method === m ? 'on' : ''} ${disabled ? 'disabled' : ''}`}>
              <input type="radio" name="subpay" disabled={disabled} checked={method === m} onChange={() => setMethod(m)} />
              <div>
                <strong>{PAYMENT_LABEL[m]}</strong>
                <p className="muted small">
                  {m === 'autopay' && (disabled ? 'Not configured yet' : 'Approve once in your UPI app; each delivery is auto-debited')}
                  {m === 'wallet' && <>Prepaid · balance {rupees(user?.wallet_paise)} · <Link to="/wallet">Top up</Link></>}
                  {m === 'cod' && 'Pay cash to your milk agent, settled weekly'}
                </p>
              </div>
            </label>
          )
        })}
      </section>

      <section className="card summary">
        <div className="row between"><span>Per delivery</span><strong>{rupees(perDelivery)}</strong></div>
        <div className="row between"><span>Estimated per month</span><span>{rupees(perMonth)}</span></div>
        <p className="muted small">
          You're only charged for days we deliver. Skip by {config.skip_cutoff_hour}:00 the night before. Missed deliveries are credited back.
        </p>
      </section>
      {err && <p className="error">{err}</p>}
      <button className="btn btn-block btn-lg sticky-cta" disabled={busy || !product} onClick={submit}>
        {busy ? 'Starting…' : method === 'autopay' ? 'Set up AutoPay & subscribe' : 'Confirm subscription'}
      </button>
    </div>
  )
}
