import { createPortal } from 'react-dom'
import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { rupees } from '../lib'
import { useAuth } from '../state'
import type { PaymentIntent, User } from '../types'
import { IconBank, IconCard, IconCheck, IconLock, IconPhone, IconX, Logo } from './icons'

type Result = { status: 'paid' | 'failed' | 'dismissed'; message?: string }
type PayFn = (intent: PaymentIntent, description: string) => Promise<Result>
const PayCtx = createContext<PayFn>(async () => ({ status: 'failed' }))

type RazorpayResponse = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }
type RazorpayCtor = new (opts: Record<string, unknown>) => { open: () => void }

let checkoutScript: Promise<void> | null = null
function loadCheckout() {
  checkoutScript ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement('script')
    el.src = 'https://checkout.razorpay.com/v1/checkout.js'
    el.onload = () => resolve()
    el.onerror = () => {
      checkoutScript = null
      reject(new Error("Couldn't load the payment page. Check your connection and try again."))
    }
    document.head.appendChild(el)
  })
  return checkoutScript
}

/** Live payments (server with Razorpay keys): Razorpay Checkout, then the server verifies the signature. */
async function razorpayCheckout(intent: PaymentIntent, description: string, key: string, user: User | null): Promise<Result> {
  try {
    await loadCheckout()
  } catch (e) {
    return { status: 'failed', message: (e as Error).message }
  }
  const Razorpay = (window as unknown as { Razorpay: RazorpayCtor }).Razorpay
  return new Promise<Result>((resolve) => {
    new Razorpay({
      key, order_id: intent.razorpay_order_id, amount: intent.amount_paise, currency: 'INR', name: 'MooNest', description,
      ...(intent.recurring ? { customer_id: intent.customer_id, recurring: 1 } : {}),
      prefill: { name: user?.name, email: user?.email, contact: user?.phone ? `+91${user.phone}` : undefined },
      theme: { color: '#2f6b4f' },
      handler: async (r: RazorpayResponse) => {
        try {
          const v = await api<{ status: string; message?: string }>('/api/payments/verify', { body: { payment_id: intent.payment_id, ...r } })
          resolve(v.status === 'paid' ? { status: 'paid' } : { status: 'failed', message: v.message })
        } catch (e) {
          resolve({ status: 'failed', message: (e as Error).message })
        }
      },
      modal: { ondismiss: () => resolve({ status: 'dismissed', message: 'Payment cancelled' }) },
    }).open()
  })
}

/**
 * Payments. Test mode (the published build, or a server without gateway keys) uses the built-in
 * checkout sheet (UPI, card, netbanking): every step and check is real, no money moves.
 * With Razorpay keys on the server, intents arrive with `demo: false` and open Razorpay Checkout.
 */
export function PaymentProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ intent: PaymentIntent; description: string } | null>(null)
  const resolver = useRef<(r: Result) => void>()
  const { config, user } = useAuth()
  const pay = useCallback<PayFn>(
    (intent, description) => {
      if (!intent.demo && config?.razorpay_key_id) return razorpayCheckout(intent, description, config.razorpay_key_id, user)
      return new Promise<Result>((resolve) => {
        resolver.current = resolve
        setOpen({ intent, description })
      })
    },
    [config, user],
  )
  const finish = (r: Result) => {
    setOpen(null)
    resolver.current?.(r)
  }
  return (
    <PayCtx.Provider value={pay}>
      {children}
      {open && <CheckoutSheet intent={open.intent} description={open.description} onDone={finish} />}
    </PayCtx.Provider>
  )
}
export const usePay = () => useContext(PayCtx)

// ---------------------------------------------------------------- helpers
const UPI_APPS = [
  { id: 'gpay', name: 'Google Pay', color: '#4285f4', handle: 'okaxis' },
  { id: 'phonepe', name: 'PhonePe', color: '#5f259f', handle: 'ybl' },
  { id: 'paytm', name: 'Paytm', color: '#00baf2', handle: 'paytm' },
  { id: 'bhim', name: 'BHIM', color: '#e8710a', handle: 'upi' },
]
const BANKS = ['State Bank of India', 'HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Kotak Mahindra Bank', 'Canara Bank']
const DECLINE_CARD = '4000000000000002'

function luhn(num: string) {
  let sum = 0
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i])
    if (i % 2) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return num.length >= 12 && sum % 10 === 0
}
function brand(num: string) {
  if (/^4/.test(num)) return 'Visa'
  if (/^(5[1-5]|2[2-7])/.test(num)) return 'Mastercard'
  if (/^(60|65|81|82|508)/.test(num)) return 'RuPay'
  if (/^3[47]/.test(num)) return 'Amex'
  return ''
}
function expiryOk(v: string) {
  const m = v.match(/^(\d{2})\/(\d{2})$/)
  if (!m) return false
  const mm = Number(m[1]), yy = 2000 + Number(m[2])
  if (mm < 1 || mm > 12) return false
  const now = new Date()
  return yy > now.getFullYear() || (yy === now.getFullYear() && mm >= now.getMonth() + 1)
}
const txnId = () => 'pay_' + Math.random().toString(36).slice(2, 8).toUpperCase() + Date.now().toString(36).slice(-6).toUpperCase()

type Stage = 'choose' | 'otp' | 'processing' | 'success' | 'failed'

function CheckoutSheet({ intent, description, onDone }: { intent: PaymentIntent; description: string; onDone: (r: Result) => void }) {
  const [tab, setTab] = useState<'upi' | 'card' | 'netbanking'>('upi')
  const [stage, setStage] = useState<Stage>('choose')
  const [upiApp, setUpiApp] = useState<string | null>(null)
  const [vpa, setVpa] = useState('')
  const [card, setCard] = useState({ number: '', name: '', expiry: '', cvv: '' })
  const [bank, setBank] = useState<string | null>(null)
  const [otp, setOtp] = useState('')
  const [msg, setMsg] = useState('')
  const [receipt, setReceipt] = useState<{ id: string; method: string; at: Date } | null>(null)
  const [error, setError] = useState('')
  const recurring = !!intent.recurring
  const tabs: ['upi' | 'card' | 'netbanking', string, ReactNode][] = recurring
    ? [['upi', 'UPI AutoPay', <IconPhone size={18} key="u" />]]
    : [['upi', 'UPI', <IconPhone size={18} key="u" />], ['card', 'Card', <IconCard size={18} key="c" />], ['netbanking', 'Netbanking', <IconBank size={18} key="n" />]]

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && (stage === 'choose' || stage === 'failed') && onDone({ status: 'dismissed', message: 'Payment cancelled' })
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [stage, onDone])

  const cardNum = card.number.replace(/\s/g, '')
  const vpaOk = /^[\w.-]{2,}@[a-z]{2,}$/i.test(vpa)
  const cardOk = luhn(cardNum) && card.name.trim().length > 1 && expiryOk(card.expiry) && /^\d{3,4}$/.test(card.cvv)
  const canPay = tab === 'upi' ? !!upiApp || vpaOk : tab === 'card' ? cardOk : !!bank
  const methodLabel = tab === 'upi' ? (upiApp ? UPI_APPS.find((a) => a.id === upiApp)!.name : vpa) : tab === 'card' ? `${brand(cardNum) || 'Card'} •••• ${cardNum.slice(-4)}` : bank!

  const settle = async (ok: boolean, failMsg = '') => {
    try {
      const r = await api<{ status: string; message?: string }>('/api/payments/verify', {
        body: { payment_id: intent.payment_id, demo_outcome: ok ? 'success' : 'failure', method: tab, method_detail: methodLabel },
      })
      if (r.status === 'paid') {
        setReceipt({ id: txnId(), method: methodLabel, at: new Date() })
        setStage('success')
      } else {
        setError(failMsg || r.message || 'Payment failed')
        setStage('failed')
      }
    } catch (e) {
      setError((e as Error).message)
      setStage('failed')
    }
  }

  const process = (text: string, ms: number, ok = true, failMsg = '') => {
    setMsg(text)
    setStage('processing')
    setTimeout(() => settle(ok, failMsg), ms)
  }

  const payNow = () => {
    setError('')
    if (tab === 'upi') process(recurring ? `Approve the AutoPay mandate in ${methodLabel}…` : `Approve ₹${intent.amount_paise / 100} in ${methodLabel}…`, 2600)
    else if (tab === 'card') {
      if (cardNum === DECLINE_CARD) return process('Contacting your bank…', 1800, false, 'Your bank declined this card. Try another card or UPI.')
      setOtp('')
      setStage('otp')
    } else process(`Redirecting to ${bank}…`, 2400)
  }

  const dismissable = stage === 'choose' || stage === 'failed'
  return createPortal(
    <div className="modal-backdrop" onClick={() => dismissable && onDone({ status: 'dismissed', message: 'Payment cancelled' })}>
      <div className="modal pay-sheet" role="dialog" aria-modal="true" aria-label="Payment" onClick={(e) => e.stopPropagation()}>
        <div className="pay-head">
          <Logo size={30} />
          <div className="pay-amount">
            <span className="muted small">{description}</span>
            <strong>{rupees(intent.amount_paise)}</strong>
          </div>
          {dismissable && (
            <button className="icon-btn" aria-label="Close" onClick={() => onDone({ status: 'dismissed', message: 'Payment cancelled' })}>
              <IconX />
            </button>
          )}
        </div>
        <p className="test-mode"><IconLock size={14} /> Secure checkout · Test mode, no real money is charged</p>

        {stage === 'choose' && (
          <>
            {tabs.length > 1 && (
              <div className="pay-tabs" role="tablist">
                {tabs.map(([id, label, icon]) => (
                  <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
                    {icon} {label}
                  </button>
                ))}
              </div>
            )}

            {tab === 'upi' && (
              <div className="pay-body">
                {recurring && (
                  <p className="notice small">AutoPay mandate: MooNest can debit each delivery's amount (up to ₹500 per debit) from your UPI account. Cancel anytime from your UPI app.</p>
                )}
                <p className="label">Pay with a UPI app</p>
                <div className="upi-grid">
                  {UPI_APPS.map((a) => (
                    <button key={a.id} className={`upi-app ${upiApp === a.id ? 'on' : ''}`} onClick={() => { setUpiApp(a.id); setVpa('') }}>
                      <span className="upi-logo" style={{ background: a.color }}>{a.name[0]}</span>
                      {a.name}
                    </button>
                  ))}
                </div>
                <p className="label">Or enter UPI ID</p>
                <input className="input" placeholder="name@okhdfcbank" value={vpa} onChange={(e) => { setVpa(e.target.value.trim()); setUpiApp(null) }} aria-label="UPI ID" />
                {vpa && !vpaOk && <p className="error">Enter a valid UPI ID, like name@okaxis</p>}
              </div>
            )}

            {tab === 'card' && (
              <div className="pay-body">
                <label className="field">
                  <span>Card number</span>
                  <div className="input-with-tag">
                    <input
                      className="input"
                      inputMode="numeric"
                      autoComplete="cc-number"
                      placeholder="4111 1111 1111 1111"
                      value={card.number}
                      onChange={(e) => setCard({ ...card, number: e.target.value.replace(/\D/g, '').slice(0, 19).replace(/(\d{4})(?=\d)/g, '$1 ') })}
                    />
                    {brand(cardNum) && <span className="tag">{brand(cardNum)}</span>}
                  </div>
                  {cardNum.length >= 12 && !luhn(cardNum) && <span className="error">This card number isn't valid</span>}
                </label>
                <label className="field"><span>Name on card</span><input className="input" autoComplete="cc-name" value={card.name} onChange={(e) => setCard({ ...card, name: e.target.value })} /></label>
                <div className="row gap">
                  <label className="field grow">
                    <span>Expiry</span>
                    <input
                      className="input"
                      inputMode="numeric"
                      autoComplete="cc-exp"
                      placeholder="MM/YY"
                      value={card.expiry}
                      onChange={(e) => {
                        const d = e.target.value.replace(/\D/g, '').slice(0, 4)
                        setCard({ ...card, expiry: d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d })
                      }}
                    />
                    {card.expiry.length === 5 && !expiryOk(card.expiry) && <span className="error">Card expired or invalid</span>}
                  </label>
                  <label className="field grow">
                    <span>CVV</span>
                    <input className="input" inputMode="numeric" type="password" autoComplete="cc-csc" placeholder="•••" value={card.cvv} onChange={(e) => setCard({ ...card, cvv: e.target.value.replace(/\D/g, '').slice(0, 4) })} />
                  </label>
                </div>
                <p className="muted small">Test cards: 4111 1111 1111 1111 succeeds · 4000 0000 0000 0002 is declined. Any future expiry and CVV.</p>
              </div>
            )}

            {tab === 'netbanking' && (
              <div className="pay-body bank-list">
                {BANKS.map((b) => (
                  <button key={b} className={`option ${bank === b ? 'on' : ''}`} onClick={() => setBank(b)}>
                    <span className="bank-logo"><IconBank size={18} /></span> {b}
                  </button>
                ))}
              </div>
            )}

            <button className="btn btn-block btn-lg" disabled={!canPay} onClick={payNow}>
              {recurring ? 'Authorise AutoPay' : `Pay ${rupees(intent.amount_paise)}`}
            </button>
          </>
        )}

        {stage === 'otp' && (
          <div className="pay-body center-col">
            <p><strong>Verify with your bank</strong></p>
            <p className="muted small">Enter the 6-digit OTP sent to the mobile number linked with your {brand(cardNum) || 'card'} ending {cardNum.slice(-4)}. In test mode any 6 digits work.</p>
            <input className="input otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus aria-label="Bank OTP" />
            <button className="btn btn-block btn-lg" disabled={otp.length !== 6} onClick={() => process('Confirming payment with your bank…', 1600)}>Submit OTP</button>
            <button className="link-btn" onClick={() => setStage('choose')}>Use another method</button>
          </div>
        )}

        {stage === 'processing' && (
          <div className="pay-body center-col">
            <span className="pay-spinner" />
            <p><strong>{msg}</strong></p>
            <p className="muted small">Don't close this window.</p>
          </div>
        )}

        {stage === 'success' && receipt && (
          <div className="pay-body center-col">
            <span className="pay-success"><IconCheck size={34} /></span>
            <h3 className="display-xs">{recurring ? 'AutoPay set up' : 'Payment successful'}</h3>
            <p className="big-amount">{rupees(intent.amount_paise)}</p>
            <div className="receipt">
              <div className="kv"><span>Paid via</span><strong>{receipt.method}</strong></div>
              <div className="kv"><span>Transaction ID</span><strong className="mono">{receipt.id}</strong></div>
              <div className="kv"><span>Date</span><strong>{receipt.at.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</strong></div>
            </div>
            <button className="btn btn-block btn-lg" onClick={() => onDone({ status: 'paid' })}>Done</button>
          </div>
        )}

        {stage === 'failed' && (
          <div className="pay-body center-col">
            <span className="pay-fail"><IconX size={30} /></span>
            <h3 className="display-xs">Payment failed</h3>
            <p className="muted">{error}</p>
            <button className="btn btn-block btn-lg" onClick={() => onDone({ status: 'failed', message: error })}>{intent.recurring ? 'Back to subscription' : /wallet top-up/i.test(description) ? 'Back to wallet' : 'Back to order'}</button>
            <p className="muted small">{intent.recurring ? 'You can set up AutoPay again from the subscription.' : /wallet top-up/i.test(description) ? 'Nothing was charged. You can try again.' : 'You can retry from the order page.'}</p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
