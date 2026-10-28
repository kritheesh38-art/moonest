import { useEffect, useState } from 'react'
import { api } from '../api'
import { disablePush, enablePush, pushState, type PushState } from '../push'
import { useToast } from '../state'
import { IconBell } from './icons'

const DISMISS = 'moonest:push-nudge-dismissed'

/** Turn phone notifications on or off. `nudge`: the small banner on Home, shown only while they're off. */
export default function PushCard({ nudge = false }: { nudge?: boolean }) {
  const toast = useToast()
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [hidden, setHidden] = useState(() => {
    try {
      return nudge && localStorage.getItem(DISMISS) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    pushState().then(setState)
  }, [])

  const turnOn = async () => {
    setBusy(true)
    try {
      const s = await enablePush()
      setState(s)
      if (s === 'on') {
        await api('/api/push/test', { method: 'POST' }).catch(() => undefined)
        toast('Notifications are on. You should get a test alert now', 'ok')
      } else if (s === 'blocked') toast('Notifications are blocked for this site. Allow them in your browser settings', 'bad')
    } catch (e) {
      toast((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }
  const turnOff = async () => {
    setBusy(true)
    setState(await disablePush())
    setBusy(false)
    toast('Notifications are off', 'ok')
  }

  if (nudge) {
    if (hidden || state !== 'off') return null
    return (
      <div className="card push-nudge">
        <IconBell size={22} />
        <div>
          <strong>Know when your milk arrives</strong>
          <p className="muted small">Get an alert when the agent starts and when it's delivered, even with the app closed.</p>
        </div>
        <div className="row gap">
          <button className="btn btn-sm" disabled={busy} onClick={turnOn}>{busy ? 'Turning on…' : 'Turn on'}</button>
          <button className="btn-text small" onClick={() => { setHidden(true); try { localStorage.setItem(DISMISS, '1') } catch { /* fine */ } }}>Not now</button>
        </div>
      </div>
    )
  }

  return (
    <section className="card stack-sm">
      <h3>Notifications</h3>
      <p className="muted small">Alerts on this phone when your milk is on the way and when it's delivered, even when the app is closed. Updates also appear under the bell icon.</p>
      {state === 'on' ? (
        <>
          <div className="row gap wrap center-row">
            <p className="ok small">Notifications are on for this device</p>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => api('/api/push/test', { method: 'POST' }).then(() => toast('Test alert sent', 'ok'))}>Send a test</button>
            <button className="btn-text small" disabled={busy} onClick={turnOff}>Turn off</button>
          </div>
          <ReminderToggle />
        </>
      ) : state === 'blocked' ? (
        <p className="muted small">Notifications are blocked for this site. Allow them in your browser: tap the lock or ⓘ by the address bar → Permissions → Notifications → Allow, then come back here.</p>
      ) : state === 'needs-install' ? (
        <p className="muted small">On iPhone, first add MooNest to your home screen: tap Share → Add to Home Screen, open MooNest from there, and turn notifications on here.</p>
      ) : state === 'unsupported' ? (
        <p className="muted small">This browser can't show notifications. Updates appear under the bell icon.</p>
      ) : (
        <button className="btn btn-sm" disabled={busy || state === null} onClick={turnOn}>{busy ? 'Turning on…' : 'Turn on notifications'}</button>
      )}
    </section>
  )
}

/** The evening "Milk tomorrow, skip?" reminder, an hour before the cutoff. */
function ReminderToggle() {
  const toast = useToast()
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    api<{ skip_reminders: boolean }>('/api/push/prefs').then((p) => setOn(p.skip_reminders)).catch(() => setOn(null))
  }, [])
  if (on === null) return null
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={on}
        onChange={async (e) => {
          const v = e.target.checked
          setOn(v)
          try {
            await api('/api/push/prefs', { method: 'PUT', body: { skip_reminders: v } })
          } catch (err) {
            setOn(!v)
            toast((err as Error).message, 'bad')
          }
        }}
      />
      Evening reminder before the skip cutoff, with a one-tap "Skip tomorrow" button
    </label>
  )
}
