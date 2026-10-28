import React, { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { IconArrowLeft, IconBottle, IconX, Logo } from './icons'
import { firstName, greetingFor, istHour, isValidPhone, PHONE_ERROR, sanitizePhone } from '../lib'
import { useAuth } from '../state'
import { SHARED_APP_URL } from '../api'

/** 10-digit Indian mobile input with fixed +91 prefix. Blocks non-digits and anything past 10 digits. */
export function PhoneInput({
  value,
  onChange,
  label = 'Mobile number',
  autoFocus,
  required = true,
  id = 'phone',
}: {
  value: string
  onChange: (v: string) => void
  label?: string
  autoFocus?: boolean
  required?: boolean
  id?: string
}) {
  const [touched, setTouched] = useState(false)
  const showError = touched && value.length > 0 && !isValidPhone(value)
  const showRequired = touched && required && value.length === 0
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className={`phone-input ${showError || showRequired ? 'invalid' : ''}`}>
        <span className="prefix">+91</span>
        <input
          id={id}
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          placeholder="98765 43210"
          maxLength={10}
          minLength={10}
          pattern="[6-9][0-9]{9}"
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(sanitizePhone(e.target.value))}
          onPaste={(e) => {
            e.preventDefault()
            onChange(sanitizePhone(e.clipboardData.getData('text')))
          }}
          onKeyDown={(e) => {
            if (e.key.length === 1 && !/\d/.test(e.key) && !e.ctrlKey && !e.metaKey) e.preventDefault()
          }}
          onBlur={() => setTouched(true)}
          aria-invalid={showError}
          aria-describedby={`${id}-err`}
        />
        <span className="count">{value.length}/10</span>
      </div>
      {(showError || showRequired) && (
        <p className="error" id={`${id}-err`}>
          {PHONE_ERROR}
        </p>
      )}
    </div>
  )
}

export function Field({ label, error, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string }) {
  return (
    <div className="field">
      <label htmlFor={props.id ?? props.name}>{label}</label>
      <input id={props.id ?? props.name} {...props} className={error ? 'invalid' : ''} />
      {error && <p className="error">{error}</p>}
    </div>
  )
}

/** Greeting that follows the time of day in India and re-checks every minute. */
export function useGreeting(name?: string | null) {
  const [hour, setHour] = useState(istHour())
  useEffect(() => {
    const t = setInterval(() => setHour(istHour()), 60_000)
    return () => clearInterval(t)
  }, [])
  const fn = firstName(name)
  return { text: `${greetingFor(hour)}${fn ? `, ${fn}` : ''}`, hour }
}

export function Greeting({ name, subtitle }: { name?: string | null; subtitle?: ReactNode }) {
  const g = useGreeting(name)
  return (
    <div className="greeting">
      <h1>
        {g.text}
      </h1>
      {subtitle && <p className="muted">{subtitle}</p>}
    </div>
  )
}

/** Shimmering placeholder cards while a screen loads. */
export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="skeleton-stack" role="status" aria-label={label}>
      <div className="skeleton sk-title" />
      <div className="skeleton sk-card" />
      <div className="skeleton sk-card short" />
    </div>
  )
}

/** Fades and lifts each new screen in, and starts it at the top. */
export function PageTransition({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  useEffect(() => {
    try {
      window.scrollTo({ top: 0 })
    } catch {
      /* ignore */
    }
  }, [pathname])
  return (
    <div key={pathname} className="page-enter">
      {children}
    </div>
  )
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card error-box">
      <p>{message}</p>
      {onRetry && (
        <button className="btn btn-ghost" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}

export function Badge({ tone = 'muted', children }: { tone?: string; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon" aria-hidden>
        <IconBottle size={34} />
      </div>
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  )
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

export function TopBar({ title, back, right }: { title: string; back?: string; right?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        {back ? (
          <Link to={back} className="icon-btn" aria-label="Back">
            <IconArrowLeft />
          </Link>
        ) : (
          <Link to="/" aria-label="MooNest home"><Logo size={36} /></Link>
        )}
        {back && <h2>{title}</h2>}
        <div className="topbar-right">{right}</div>
      </div>
    </header>
  )
}

export function BottomNav({ items }: { items: { to: string; label: string; icon: ReactNode; badge?: number }[] }) {
  const { pathname } = useLocation()
  const active = items.findIndex((i) => (i.to.split('/').length <= 2 ? pathname === i.to : pathname.startsWith(i.to)))
  return (
    // off the main tabs (orders, notifications…) no tab is highlighted
    <nav className={`bottom-nav ${active < 0 ? 'no-active' : ''}`} style={{ '--i': Math.max(0, active), '--n': items.length } as React.CSSProperties}>
      {items.map((i) => (
        <NavLink key={i.to} to={i.to} end={i.to.split('/').length <= 2}>
          <span className="nav-icon" aria-hidden>
            {i.icon}
          </span>
          <span>{i.label}</span>
          {!!i.badge && <span className="nav-badge">{i.badge}</span>}
        </NavLink>
      ))}
    </nav>
  )
}

/** Two-tap confirm: first tap arms the button, second tap within 4 s runs the action. */
export function ConfirmButton({ onConfirm, confirmLabel = 'Tap again to confirm', children, className = 'btn btn-danger', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { onConfirm: () => void; confirmLabel?: string }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button {...rest} className={`${className}${armed ? ' armed' : ''}`} onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}>
      {armed ? confirmLabel : children}
    </button>
  )
}

/**
 * A private copy (someone who can only view the claude.ai link, e.g. from outside the organisation)
 * keeps orders in that browser alone. Point them to the shared app, where everyone sees the same data.
 */
export function PrivateCopyBanner() {
  const mode = (window as unknown as { __moonestMode?: string }).__moonestMode
  const [hidden, setHidden] = useState(() => {
    try {
      return sessionStorage.getItem('moonest_private_banner') === 'hidden'
    } catch {
      return false
    }
  })
  if (mode !== 'local' || hidden) return null
  return (
    <div className="private-banner" role="note">
      <p>
        <strong>This is your private copy.</strong> Orders here stay in this browser only. Use the shared app so everyone sees the same orders.
      </p>
      <a className="btn btn-sm" href={SHARED_APP_URL} target="_blank" rel="noopener noreferrer">Open shared app ↗</a>
      <button
        type="button"
        className="icon-btn"
        aria-label="Hide"
        onClick={() => {
          setHidden(true)
          try {
            sessionStorage.setItem('moonest_private_banner', 'hidden')
          } catch {
            /* ignore */
          }
        }}
      >
        <IconX size={16} />
      </button>
    </div>
  )
}

/** Shows which data mode this build is running in. */
export function DemoBar() {
  const mode = (window as unknown as { __moonestMode?: string }).__moonestMode
  const { config } = useAuth()
  if (mode === 'server' && !config?.demo_mode) return null
  return (
    <p className="demo-banner small">
      {mode === 'server'
        ? 'Demo server · OTPs are shown on screen and payments run in test mode when no gateway keys are set.'
        : mode === 'shared'
        ? 'Demo build · shared with people in your organisation who can edit this link. Friends outside it get a private copy; send them the shared app link instead.'
        : 'Demo build · private copy, saved in this browser only. Payments and OTPs are simulated.'}
    </p>
  )
}
