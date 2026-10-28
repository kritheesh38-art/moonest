import { FormEvent, useEffect, useState } from 'react'
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { IconArrowRight, IconBottle, IconClock, IconLeaf, IconShield, Logo } from '../components/icons'
import { HeroArt } from '../components/ProductArt'
import { Field, PhoneInput } from '../components/ui'
import { isValidPhone } from '../lib'
import { useAuth, useToast } from '../state'
import type { Role, User } from '../types'

const HOME: Record<Role, string> = { customer: '/', agent: '/agent', admin: '/admin' }

function Segmented<T extends string>({ value, options, onChange, size = 'md' }: { value: T; options: [T, string][]; onChange: (v: T) => void; size?: 'md' | 'sm' }) {
  const i = Math.max(0, options.findIndex(([v]) => v === value))
  return (
    <div className={`seg seg-${size}`} role="tablist" style={{ '--i': i, '--n': options.length } as React.CSSProperties}>
      {options.map(([v, label]) => (
        <button key={v} type="button" role="tab" aria-selected={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- landing
export function Landing() {
  const { user, config } = useAuth()
  const nav = useNavigate()
  if (user) return <Navigate to={HOME[user.role]} replace />
  return (
    <div className="landing">
      <header className="landing-nav">
        <Logo />
        <div className="row gap">
          <Link to="/login" className="btn-text">Sign in</Link>
          <Link to="/signup" className="btn">Get started</Link>
        </div>
      </header>
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow-chip"><IconLeaf size={15} /> Hyperlocal{config?.city ? ` · ${config.city}` : ''} · Every morning</span>
          <h1 className="display">
            Fresh milk at your <em className="accent">doorstep</em>, before the kettle whistles.
          </h1>
          <p className="lede">Aavin, Arokya and Heritage milk, plus curd, paneer, butter and ghee, delivered every morning. Pick your packet colour, live track your milk agent, pause for vacations, skip any day before 10 PM.</p>
          <div className="row gap wrap">
            <button className="btn btn-lg" onClick={() => nav('/signup')}>Start a plan <IconArrowRight size={18} /></button>
            {config?.demo_mode && <button className="btn btn-outline btn-lg" onClick={() => nav('/live-demo')}>See live tracking</button>}
          </div>
          {config?.demo_mode ? (
            <p className="explore-as">
              <span>Explore as</span>
              <Link to="/login?as=customer">Customer</Link>
              <Link to="/login?as=agent">Milk agent</Link>
            </p>
          ) : (
            <button className="btn-text agent-link" onClick={() => nav('/login?role=agent')}>I'm a milk agent →</button>
          )}
          <p className="brands-carried"><span>Delivering</span> Aavin · Arokya · Heritage · Amul · Farm Fresh</p>
          <div className="feature-chips">
            <span><IconClock size={17} /> 5:30 AM slot</span>
            <span><IconShield size={17} /> Sealed packets</span>
            <span><IconBottle size={17} /> Pick your colour</span>
          </div>
        </div>
        <div className="hero-visual">
          <div className="hero-photo">
            <HeroArt />
            <div className="hero-caption"><span>EVERY MORNING</span><strong>Fresh milk, delivered</strong></div>
          </div>
          <div className="float-card">
            <span className="float-icon"><IconLeaf size={18} /></span>
            <div>
              <span className="muted small">Today's route</span>
              <strong>Out for delivery · 5:00 AM</strong>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

// ---------------------------------------------------------------- sign in
const DEMO_PASSWORD = 'pass1234'
/** Demo accounts (seeded in demo mode on both the in-browser build and the server). */
/** Admin is private: no demo account, no one-tap and no OTP for it. */
const QUICK: Partial<Record<Role, { email: string; label: string; who: string }>> = {
  customer: { email: 'customer@moonest.in', label: 'Customer', who: 'Aditi · orders & tracking' },
  agent: { email: 'agent@moonest.in', label: 'Milk agent', who: 'Ravi · route & delivery' },
}

export default function Login() {
  const { user, login, config } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const loc = useLocation()
  const adminMode = loc.pathname.startsWith('/admin')
  const [role, setRole] = useState<Role>(adminMode ? 'admin' : new URLSearchParams(loc.search).get('role') === 'agent' ? 'agent' : 'customer')
  const [method, setMethod] = useState<'password' | 'otp'>('password')
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [phone, setPhone] = useState('')
  const [step, setStep] = useState<'id' | 'otp'>('id')
  const [code, setCode] = useState('')
  const [devOtp, setDevOtp] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [resendIn, setResendIn] = useState(0)

  // Demo: /login?as=admin (or customer / agent) signs straight in with that demo account
  const quickAs = new URLSearchParams(loc.search).get('as') as Role | null
  useEffect(() => {
    if (quickAs && config?.demo_mode && !user && QUICK[quickAs]) quick(quickAs as 'customer' | 'agent')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickAs, config?.demo_mode])

  useEffect(() => {
    if (resendIn <= 0) return
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000)
    return () => clearTimeout(t)
  }, [resendIn])

  if (user) return <Navigate to={HOME[user.role]} replace />

  const done = (r: { token: string; user: User }) => {
    login(r.token, r.user)
    toast('Signed in', 'ok')
    nav(HOME[r.user.role], { replace: true })
  }
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setErr('')
    try {
      await fn()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const quick = (r: 'customer' | 'agent') =>
    run(async () => done(await api<{ token: string; user: User }>('/api/auth/login', { body: { identifier: QUICK[r]!.email, password: DEMO_PASSWORD, role: r } })))
  const signInPassword = (e: FormEvent) => {
    e.preventDefault()
    run(async () => done(await api<{ token: string; user: User }>('/api/auth/login', { body: { identifier, password, role } })))
  }
  const requestOtp = (e?: FormEvent) => {
    e?.preventDefault()
    if (!isValidPhone(phone)) return setErr('Enter a valid 10-digit mobile number')
    run(async () => {
      const r = await api<{ dev_otp?: string }>('/api/auth/request-otp', { body: { phone, role } })
      setDevOtp(r.dev_otp ?? null)
      setStep('otp')
      setCode('')
      setResendIn(30)
    })
  }
  const verifyOtp = (e: FormEvent) => {
    e.preventDefault()
    if (code.length !== 6) return setErr('Enter the 6-digit OTP')
    run(async () => done(await api<{ token: string; user: User }>('/api/auth/verify-otp', { body: { phone, role, code } })))
  }

  const demo =
    role === 'agent' ? [['agent@moonest.in', 'pass1234']] : [['customer@moonest.in', 'pass1234']]

  return (
    <div className="auth-split">
      <aside className="auth-panel">
        <Link to="/welcome" className="auth-panel-logo"><Logo light /></Link>
        <span className="circle circle-a" />
        <span className="circle circle-b" />
        <div className="auth-panel-copy">
          <h2 className="display">Milk that remembers <em>your doorstep.</em></h2>
          <p>One tap to pause for a trip. One tap to skip tomorrow. Live map so you know when the bottles arrive.</p>
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-form">
          <Link to="/welcome" className="auth-mobile-logo"><Logo /></Link>
          <h1 className="display-sm">{adminMode ? 'Admin sign in' : 'Welcome back'}</h1>
          <p className="muted">Sign in to continue your deliveries.</p>

          {!adminMode && <Segmented value={role} options={[['customer', 'Customer'], ['agent', 'Milk Agent']]} onChange={(r) => { setRole(r); setErr('') }} />}
          {!adminMode && (config?.otp_available ?? config?.demo_mode) && <Segmented size="sm" value={method} options={[['password', 'Password'], ['otp', 'OTP']]} onChange={(m) => { setMethod(m); setStep('id'); setErr('') }} />}

          {method === 'password' ? (
            <form onSubmit={signInPassword} className="form">
              <Field label={adminMode ? 'Username' : 'Email or mobile'} name="identifier" type="text" autoComplete="username" autoCapitalize="none" placeholder={adminMode ? 'username' : 'you@moonest.in'} value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
              <Field label="Password" name="password" type="password" autoComplete="current-password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
              {err && <p className="error">{err}</p>}
              <button className="btn btn-block btn-lg" disabled={busy || !identifier || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
            </form>
          ) : step === 'id' ? (
            <form onSubmit={requestOtp} className="form">
              <PhoneInput value={phone} onChange={setPhone} />
              {err && <p className="error">{err}</p>}
              <button className="btn btn-block btn-lg" disabled={busy || !isValidPhone(phone)}>{busy ? 'Sending…' : 'Send OTP'}</button>
            </form>
          ) : (
            <form onSubmit={verifyOtp} className="form">
              <p className="muted small">
                Code sent to +91 {phone}{' '}
                <button type="button" className="link-btn" onClick={() => setStep('id')}>Change</button>
              </p>
              {devOtp && config?.demo_mode && <p className="demo-banner">Test mode OTP: <strong>{devOtp}</strong></p>}
              <Field label="OTP" name="otp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus />
              {err && <p className="error">{err}</p>}
              <button className="btn btn-block btn-lg" disabled={busy || code.length !== 6}>{busy ? 'Verifying…' : 'Verify & sign in'}</button>
              <button type="button" className="link-btn center" disabled={resendIn > 0 || busy} onClick={() => requestOtp()}>
                {resendIn > 0 ? `Resend OTP in ${resendIn}s` : 'Resend OTP'}
              </button>
            </form>
          )}

          {config?.demo_mode && !adminMode && (
            <div className="quick-roles">
              <p className="eyebrow">Testing? One tap to sign in as</p>
              <div className="quick-role-row">
                {(['customer', 'agent'] as const).map((r) => (
                  <button key={r} type="button" className="quick-role" disabled={busy} onClick={() => quick(r)}>
                    <strong>{QUICK[r]!.label}</strong>
                    <small>{QUICK[r]!.who}</small>
                  </button>
                ))}
              </div>
              {method === 'password' && (
                <p className="demo-creds">
                  Or type {demo.map(([e, p]) => (
                    <span key={e}><code>{e}</code> / <code>{p}</code></span>
                  ))}
                  {role === 'customer' && <> or use any 10-digit number with OTP</>}
                </p>
              )}
            </div>
          )}
          {!adminMode && (
            <p className="center muted">New here? <Link to={`/signup${role === 'agent' ? '?role=agent' : ''}`} className="link">Create an account</Link></p>
          )}
          <p className="center small">
            <Link to={adminMode ? '/login' : '/admin/login'} className="muted">{adminMode ? '← Customer & agent sign in' : 'Admin sign in'}</Link>
          </p>
        </div>
      </main>
    </div>
  )
}

// ---------------------------------------------------------------- sign up
export function Signup() {
  const { user, login } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const loc = useLocation()
  const [role, setRole] = useState<'customer' | 'agent'>(new URLSearchParams(loc.search).get('role') === 'agent' ? 'agent' : 'customer')
  const [f, setF] = useState({ name: '', email: '', phone: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (user) return <Navigate to={HOME[user.role]} replace />
  const valid = f.name.trim().length > 1 && /^\S+@\S+\.\S+$/.test(f.email) && isValidPhone(f.phone) && f.password.length >= 8

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setErr('')
    try {
      const r = await api<{ token: string; user: User }>('/api/auth/register', { body: { ...f, role } })
      login(r.token, r.user)
      toast(role === 'agent' ? 'Agent account created. An admin will assign your delivery areas.' : 'Welcome to MooNest!', 'ok')
      nav(HOME[r.user.role], { replace: true })
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-center">
      <form className="auth-form" onSubmit={submit}>
        <Link to="/welcome"><Logo /></Link>
        <div>
          <h1 className="display-sm">Create your MooNest</h1>
          <p className="muted">Fresh milk, every morning, zero fuss.</p>
        </div>
        <Segmented value={role} options={[['customer', 'I want milk'], ['agent', 'I deliver milk']]} onChange={setRole} />
        <Field label="Full name" name="name" autoComplete="name" value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Field label="Email" name="email" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <PhoneInput label="Phone" value={f.phone} onChange={(v) => setF({ ...f, phone: v })} />
        <Field
          label="Password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          value={f.password}
          onChange={(e) => setF({ ...f, password: e.target.value })}
          error={f.password && f.password.length < 8 ? 'At least 8 characters' : undefined}
        />
        {err && <p className="error">{err}</p>}
        <button className="btn btn-block btn-lg" disabled={busy || !valid}>{busy ? 'Creating…' : 'Create account'}</button>
        <p className="center muted">Have an account? <Link to="/login" className="link">Sign in</Link></p>
      </form>
    </div>
  )
}
