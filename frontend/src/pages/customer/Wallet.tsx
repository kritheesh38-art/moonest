import { useState } from 'react'
import { api } from '../../api'
import { usePay } from '../../components/payments'
import { ErrorBox, Modal, Spinner } from '../../components/ui'
import { fmtDate, LEDGER_REASON, rupees } from '../../lib'
import { useApi, useAuth, useToast } from '../../state'
import type { LedgerEntry, PaymentIntent } from '../../types'

interface WalletData {
  balance_paise: number
  cod_due_paise: number
  ledger: LedgerEntry[]
  cod_ledger: LedgerEntry[]
  payments: { id: string; purpose: string; amount_paise: number; status: string; created_at: string; demo: boolean }[]
}

const PRESETS = [20000, 50000, 100000, 200000]

export default function Wallet() {
  const { data, error, loading, reload } = useApi<WalletData>('/api/wallet')
  const invoices = useApi<{ month: string; deliveries: number; amount_paise: number }[]>('/api/invoices')
  const { config, refresh } = useAuth()
  const pay = usePay()
  const toast = useToast()
  const [amount, setAmount] = useState(50000)
  const [tab, setTab] = useState<'wallet' | 'cod' | 'payments' | 'invoices'>('wallet')
  const [busy, setBusy] = useState(false)
  const [invoice, setInvoice] = useState<Invoice | null>(null)

  if (loading) return <Spinner />
  if (error || !data) return <ErrorBox message={error ?? 'Could not load wallet'} onRetry={reload} />

  const topup = async () => {
    setBusy(true)
    try {
      const intent = await api<PaymentIntent>('/api/wallet/topup', { body: { amount_paise: amount } })
      const r = await pay(intent, 'MooNest wallet top-up')
      if (r.status === 'paid') {
        toast(`${rupees(amount)} added to your wallet`, 'ok')
        refresh()
        reload()
      } else toast(r.message ?? 'Top-up not completed', 'bad')
    } catch (e) {
      toast((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="stack">
      <h1>Wallet</h1>
      <div className="card wallet-card">
        <span className="muted">Wallet balance</span>
        <strong className="huge">{rupees(data.balance_paise)}</strong>
        {data.cod_due_paise > 0 && <p className="small">Cash due to milk agent: <strong>{rupees(data.cod_due_paise)}</strong></p>}
      </div>

      <section className="card">
        <h3>Add money</h3>
        <div className="chips">
          {PRESETS.map((p) => <button key={p} className={`chip ${amount === p ? 'on' : ''}`} onClick={() => setAmount(p)}>{rupees(p)}</button>)}
        </div>
        <input className="input" type="number" min={100} max={20000} value={amount / 100} onChange={(e) => setAmount(Math.round(Number(e.target.value) * 100))} aria-label="Amount in rupees" />
        <button className="btn btn-block" disabled={busy || amount < 10000 || amount > 2000000 || config?.payments_mode === 'disabled'} onClick={topup}>
          {config?.payments_mode === 'disabled' ? 'Online payments not configured' : `Add ${rupees(amount)} via UPI / Card`}
        </button>
        <p className="muted small">Min ₹100 · Max ₹20,000. Used for wallet subscriptions and orders.</p>
      </section>

      <div className="segmented">
        {(['wallet', 'cod', 'payments', 'invoices'] as const).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{{ wallet: 'Wallet', cod: 'Cash', payments: 'Payments', invoices: 'Invoices' }[t]}</button>
        ))}
      </div>

      {tab === 'wallet' && (
        <section className="card list">
          {!data.ledger.length && <p className="muted">No transactions yet.</p>}
          {data.ledger.map((e) => (
            <div key={e.id} className="row between">
              <div>
                <strong>{LEDGER_REASON[e.reason ?? ''] ?? e.reason}</strong>
                <p className="muted small">{e.note} · {fmtDate(e.created_at)}</p>
              </div>
              <strong className={e.type === 'credit' ? 'ok' : ''}>{e.type === 'credit' ? '+' : '−'}{rupees(e.amount_paise)}</strong>
            </div>
          ))}
        </section>
      )}
      {tab === 'cod' && (
        <section className="card list">
          {!data.cod_ledger.length && <p className="muted">No cash-on-delivery activity.</p>}
          {data.cod_ledger.map((e) => (
            <div key={e.id} className="row between">
              <div>
                <strong>{e.type === 'due' ? 'Delivered (cash due)' : e.type === 'collected' ? 'Cash paid' : 'Waived'}</strong>
                <p className="muted small">{e.note} · {fmtDate(e.created_at)}</p>
              </div>
              <strong className={e.type === 'due' ? '' : 'ok'}>{e.type === 'due' ? '+' : '−'}{rupees(e.amount_paise)}</strong>
            </div>
          ))}
        </section>
      )}
      {tab === 'payments' && (
        <section className="card list">
          {!data.payments.length && <p className="muted">No online payments yet.</p>}
          {data.payments.map((p) => (
            <div key={p.id} className="row between">
              <div>
                <strong>{{ order: 'Order payment', topup: 'Wallet top-up', mandate: 'AutoPay setup', autopay_debit: 'AutoPay debit' }[p.purpose] ?? p.purpose}</strong>
                <p className="muted small">{fmtDate(p.created_at)} · {p.status}{p.demo ? ' · test' : ''}</p>
              </div>
              <strong>{rupees(p.amount_paise)}</strong>
            </div>
          ))}
        </section>
      )}
      {tab === 'invoices' && (
        <section className="card list">
          {!invoices.data?.length && <p className="muted">Invoices appear after your first delivery.</p>}
          {invoices.data?.map((i) => (
            <div key={i.month} className="row between">
              <div>
                <strong>{fmtDate(i.month + '-01', { month: 'long', year: 'numeric' })}</strong>
                <p className="muted small">{i.deliveries} deliveries · {rupees(i.amount_paise)}</p>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => api<Invoice>(`/api/invoices/${i.month}`).then(setInvoice).catch((e) => toast(e.message, 'bad'))}>View invoice</button>
            </div>
          ))}
        </section>
      )}
      {invoice && (
        <Modal title={`Invoice · ${fmtDate(invoice.month + '-01', { month: 'long', year: 'numeric' })}`} onClose={() => setInvoice(null)}>
          <p className="muted small">{invoice.customer.name} · +91 {invoice.customer.phone}</p>
          <div className="table-scroll">
            <table className="table">
              <thead><tr><th>Date</th><th>Item</th><th>Qty</th><th>Amount</th></tr></thead>
              <tbody>
                {invoice.lines.map((l, k) => (
                  <tr key={k}><td>{fmtDate(l.date, { day: 'numeric', month: 'short' })} {l.slot}</td><td>{l.name}{l.unit ? ` (${l.unit})` : ''}</td><td>{l.qty}</td><td>{rupees(l.amount_paise)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row between total"><strong>Total</strong><strong>{rupees(invoice.total_paise)}</strong></div>
          <p className="muted small">Milk and fresh dairy are GST-exempt.</p>
        </Modal>
      )}
    </div>
  )
}

interface Invoice {
  month: string
  customer: { name: string; phone: string }
  lines: { date: string; slot: string; name: string; unit: string; qty: number; amount_paise: number }[]
  total_paise: number
}
