export const PHONE_RE = /^[6-9]\d{9}$/
export const PHONE_ERROR = 'Enter a valid 10-digit mobile number'

/** Keep only digits; tolerate a pasted +91 / leading 0, cap at exactly 10 digits. */
export function sanitizePhone(raw: string): string {
  let d = raw.replace(/\D/g, '')
  if (d.length > 10 && d.startsWith('91')) d = d.slice(2)
  if (d.length > 10 && d.startsWith('0')) d = d.slice(1)
  return d.slice(0, 10)
}

export const isValidPhone = (p: string) => PHONE_RE.test(p)

export function rupees(paise: number | undefined | null): string {
  const v = (paise ?? 0) / 100
  return '₹' + v.toLocaleString('en-IN', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })
}

/** Current hour in India, regardless of the device's timezone. */
export function istHour(d = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(d))
}

export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 17) return 'Good afternoon'
  if (hour >= 17 && hour < 21) return 'Good evening'
  return 'Good night'
}

export function firstName(name?: string | null): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? ''
}

export function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
}

export function fmtDate(iso: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string {
  const d = iso.length === 10 ? new Date(iso + 'T00:00:00') : new Date(iso)
  return d.toLocaleDateString('en-IN', opts)
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return d.toLocaleDateString('en-CA')
}

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export const ORDER_STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'Awaiting payment', tone: 'warn' },
  confirmed: { label: 'Confirmed', tone: 'info' },
  out_for_delivery: { label: 'Out for delivery', tone: 'info' },
  delivered: { label: 'Delivered', tone: 'ok' },
  failed: { label: 'Missed', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
}

export const PAYMENT_LABEL: Record<string, string> = {
  razorpay: 'UPI / Card / Netbanking',
  wallet: 'MooNest Wallet',
  cod: 'Cash on Delivery',
  autopay: 'UPI AutoPay',
}

export const LEDGER_REASON: Record<string, string> = {
  topup: 'Wallet top-up',
  order_payment: 'Order payment',
  subscription_delivery: 'Subscription delivery',
  missed_delivery_credit: 'Missed delivery credit',
  skipped_delivery_credit: 'Skipped delivery credit',
  refund: 'Refund',
}
