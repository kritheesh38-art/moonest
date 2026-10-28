import { Link } from 'react-router-dom'
import { IconCalendar, IconRepeat, IconSunrise } from '../../components/icons'
import { ErrorBox, Spinner } from '../../components/ui'
import { rupees } from '../../lib'
import { useApi, useAuth } from '../../state'
import type { Plan, Product } from '../../types'

const ICON: Record<Plan['code'], JSX.Element> = { daily: <IconSunrise size={24} />, alternate: <IconRepeat size={24} />, custom: <IconCalendar size={24} /> }
const PER_MONTH: Record<Plan['code'], number> = { daily: 30, alternate: 15, custom: 12 }

export default function Plans() {
  const plans = useApi<Plan[]>('/api/plans')
  const products = useApi<Product[]>('/api/products')
  const { config } = useAuth()
  if (plans.loading || products.loading) return <Spinner />
  if (plans.error) return <ErrorBox message={plans.error} onRetry={plans.reload} />
  const ref = products.data?.find((p) => p.subscribable && p.category === 'milk')
  return (
    <div className="stack">
      <h1>Subscription plans</h1>
      <p className="muted">
        Fresh milk on your schedule, at {config?.slots.map((s) => s.label).join(' or ')}. Skip before {config?.skip_cutoff_hour}:00 the night before, or
        pause for up to {config?.max_pause_days} days.
      </p>
      {plans.data?.map((p) => {
        const unit = ref ? Math.round((ref.price_paise * (100 - p.discount_pct)) / 100) : 0
        return (
          <article key={p.id} className={`card plan ${p.code === 'daily' ? 'featured' : ''}`}>
            {p.code === 'daily' && <span className="ribbon">Most popular</span>}
            <div className="row gap">
              <span className="plan-icon" aria-hidden>{ICON[p.code]}</span>
              <div>
                <h2>{p.name}</h2>
                <p className="muted small">{p.description}</p>
              </div>
            </div>
            {p.discount_pct > 0 && <p className="save">Save {p.discount_pct}% on every delivery</p>}
            <ul className="perks">{p.perks.map((x) => <li key={x}>{x}</li>)}</ul>
            {ref && (
              <p className="small">
                e.g. {ref.name} {ref.unit}: <strong>{rupees(unit)}</strong>/delivery · ≈ {rupees(unit * PER_MONTH[p.code])}/month
              </p>
            )}
            <Link to={`/subscribe?plan=${p.code}`} className="btn btn-block">Choose {p.name}</Link>
          </article>
        )
      })}
      <div className="card">
        <h3>Payment options</h3>
        <ul className="perks">
          <li><strong>UPI AutoPay</strong>: set once in your UPI app, auto-debited per delivery</li>
          <li><strong>Prepaid wallet</strong>: top up and we deduct each delivery</li>
          <li><strong>Cash on delivery</strong>: settle weekly with your milk agent</li>
        </ul>
      </div>
    </div>
  )
}
