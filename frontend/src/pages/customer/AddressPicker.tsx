import { FormEvent, lazy, Suspense, useEffect, useRef, useState } from 'react'
import { IconCheck, IconPin } from '../../components/icons'
import { api, SERVER_MODE } from '../../api'
import { Field, PhoneInput } from '../../components/ui'
import { isValidPhone } from '../../lib'
import { useAuth, useToast } from '../../state'
import type { Address } from '../../types'

const PinPicker = lazy(() => import('../../components/PinPicker'))

type Suggestion = { id: string; title: string; subtitle: string }
type Place = { lat: number; lng: number; line1?: string; line2?: string; landmark?: string; pincode?: string }
const newSession = () => (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(/[^\w-]/g, '')

/** "Search your apartment, street or area": suggestions as you type, nearest first. */
function PlaceSearch({ near, provider, onPick }: { near?: { lat?: number; lng?: number }; provider: string; onPick: (p: Place) => void }) {
  const [q, setQ] = useState('')
  const [list, setList] = useState<Suggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [msg, setMsg] = useState('')
  const session = useRef(newSession()) // one search + one pick = one session (cheaper with Google)
  const seq = useRef(0)
  const picked = useRef('')

  useEffect(() => {
    const text = q.trim()
    const n = ++seq.current
    if (text.length < 3 || text === picked.current) return setList([])
    const t = setTimeout(async () => {
      const at = near?.lat != null && near?.lng != null ? `&lat=${near.lat}&lng=${near.lng}` : ''
      try {
        const r = await api<Suggestion[]>(`/api/geocode/search?q=${encodeURIComponent(text)}&session=${session.current}${at}`)
        if (n !== seq.current) return
        setList(r)
        setActive(0)
        setOpen(true)
        setMsg(r.length ? '' : 'No matches. Try your apartment, street or area name.')
      } catch (e) {
        if (n === seq.current) setMsg((e as Error).message)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [q]) // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (s: Suggestion) => {
    setOpen(false)
    picked.current = s.title
    setQ(s.title)
    setMsg('Finding the exact spot…')
    try {
      onPick(await api<Place>(`/api/geocode/place?id=${encodeURIComponent(s.id)}&session=${session.current}`))
      setMsg('')
    } catch (e) {
      setMsg((e as Error).message)
    }
    session.current = newSession()
  }

  return (
    <div className="place-search">
      <label className="field">
        Search your apartment, street or area
        <input
          className="input"
          value={q}
          placeholder="e.g. Prestige Lakeside, 5th Cross Indiranagar"
          autoComplete="off"
          role="combobox"
          aria-expanded={open && list.length > 0}
          aria-controls="place-list"
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => list.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (!open || !list.length) return
            if (e.key === 'ArrowDown') (e.preventDefault(), setActive((a) => (a + 1) % list.length))
            else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((a) => (a - 1 + list.length) % list.length))
            else if (e.key === 'Enter') (e.preventDefault(), pick(list[active]))
            else if (e.key === 'Escape') setOpen(false)
          }}
        />
      </label>
      {open && list.length > 0 && (
        <ul className="place-list" id="place-list" role="listbox">
          {list.map((s, i) => (
            <li key={s.id} role="option" aria-selected={i === active}>
              <button type="button" className={i === active ? 'on' : ''} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
                <IconPin size={16} />
                <span><strong>{s.title}</strong>{s.subtitle && <small>{s.subtitle}</small>}</span>
              </button>
            </li>
          ))}
          {provider === 'google' && <li className="powered">powered by Google</li>}
          {provider === 'osm' && <li className="powered">© OpenStreetMap contributors</li>}
        </ul>
      )}
      {msg && <p className="muted small">{msg}</p>}
    </div>
  )
}

type Found = { line1?: string; line2?: string; landmark?: string; pincode?: string }
const pin6 = (v?: string) => {
  const d = String(v ?? '').replace(/\D/g, '')
  return d.length === 6 && d[0] !== '0' ? d : ''
}
const join = (...parts: (string | undefined)[]) => [...new Set(parts.filter(Boolean))].join(', ')
/** Keep what we have, fill the gaps from `more`. */
const merge = (a: Found, more: Found): Found => ({
  line1: a.line1 || more.line1, line2: a.line2 || more.line2, landmark: a.landmark || more.landmark, pincode: a.pincode || more.pincode,
})

/** Free, keyless lookups made from the customer's own browser (OpenStreetMap, then BigDataCloud for the pincode). */
async function browserLookup(lat: number, lng: number): Promise<Found> {
  let out: Found = {}
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&accept-language=en&lat=${lat}&lon=${lng}`)
    if (r.ok) {
      const a = (await r.json()).address ?? {}
      out = {
        line1: join(a.house_number, a.building),
        line2: join(a.road || a.pedestrian || a.residential, a.suburb || a.neighbourhood || a.quarter || a.city_district, a.city || a.town || a.village || a.county),
        landmark: a.amenity || a.shop || '',
        pincode: pin6(a.postcode),
      }
    }
  } catch {
    /* next service */
  }
  if (!out.pincode || !out.line2) {
    try {
      const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`)
      if (r.ok) {
        const d = await r.json()
        out = merge(out, { line2: join(d.locality, d.city), pincode: pin6(d.postcode) })
      }
    } catch {
      /* give up: the location is still pinned */
    }
  }
  return out
}

export function AddressForm({ initial, onSaved, onCancel }: { initial?: Address; onSaved: (a: Address) => void; onCancel?: () => void }) {
  const toast = useToast()
  const { config } = useAuth()
  const [f, setF] = useState({
    label: initial?.label ?? 'Home',
    line1: initial?.line1 ?? '',
    line2: initial?.line2 ?? '',
    landmark: initial?.landmark ?? '',
    pincode: initial?.pincode ?? '',
    contact_phone: initial?.contact_phone ?? '',
    lat: initial?.lat as number | undefined,
    lng: initial?.lng as number | undefined,
    is_default: initial?.is_default ?? false,
  })
  const [pinState, setPinState] = useState<null | { ok: boolean; area?: string }>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }))

  const checkPin = async (pin: string) => {
    set('pincode', pin)
    setPinState(null)
    if (pin.length === 6) {
      try {
        const r = await api<{ serviceable: boolean; area?: { name: string } }>(`/api/serviceability/${pin}`)
        setPinState({ ok: r.serviceable, area: r.area?.name })
      } catch {
        /* ignore */
      }
    }
  }

  const [locating, setLocating] = useState(false)
  const inPreview = (() => {
    try {
      return window.top !== window.self
    } catch {
      return true
    }
  })()

  /** Look the position up into address fields: the server first, then (server build only) straight from
   *  this browser, so a host that a lookup service blocks still works. Fields are overwritten, except
   *  the flat / house number, which is only filled when empty. */
  const fillFrom = async (lat: number, lng: number) => {
    let found: Found = {}
    if (config?.geocoding) {
      try {
        found = await api<Found>(`/api/geocode/reverse?lat=${lat}&lng=${lng}`)
      } catch {
        /* try from the browser below */
      }
    }
    if (SERVER_MODE && (!found.line2 || !found.pincode)) found = merge(found, await browserLookup(lat, lng))
    if (!found.line2 && !found.pincode) return null
    setF((x) => ({
      ...x,
      line1: x.line1 || found.line1 || '',
      line2: found.line2 || x.line2,
      landmark: found.landmark || x.landmark,
    }))
    if (found.pincode) await checkPin(found.pincode)
    return found
  }

  const locate = () => {
    if (!navigator.geolocation) return toast('This browser can\'t share location. Type your address instead.', 'bad')
    setLocating(true)
    const ok = async (p: GeolocationPosition) => {
      const { latitude: lat, longitude: lng } = p.coords
      setF((x) => ({ ...x, lat, lng }))
      const filled = await fillFrom(lat, lng)
      setLocating(false)
      toast(
        !filled ? 'Location pinned for the milk agent. Type the address below.'
          : filled.line1 || f.line1 ? 'Address filled from your location. Check it before saving.'
          : 'Address filled from your location. Add your flat / house number.',
        'ok',
      )
    }
    const failed = (e: GeolocationPositionError) => {
      setLocating(false)
      if (e.code === e.PERMISSION_DENIED)
        toast(
          inPreview
            ? 'Location is blocked inside this preview. Type your address, or open the app in its own browser tab.'
            : 'Location permission is off for this site. Allow it in your browser (tap the lock icon by the address bar; on iPhone: Settings → Privacy → Location Services → Safari Websites → While Using), then try again.',
          'bad',
        )
      else if (e.code === e.POSITION_UNAVAILABLE) toast('Your device couldn\'t find your location. Turn on Location / GPS and try again.', 'bad')
      else toast('Finding your location took too long. Try again near a window, or type your address.', 'bad')
    }
    // Precise GPS first; if it's slow (indoors, laptops), accept a quicker, rougher fix
    navigator.geolocation.getCurrentPosition(ok, (e) => {
      if (e.code === e.TIMEOUT || e.code === e.POSITION_UNAVAILABLE)
        navigator.geolocation.getCurrentPosition(ok, failed, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 })
      else failed(e)
    }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 })
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (f.contact_phone && !isValidPhone(f.contact_phone)) return setErr('Enter a valid 10-digit mobile number')
    setBusy(true)
    setErr('')
    try {
      const body = { ...f, contact_phone: f.contact_phone || null, lat: f.lat ?? null, lng: f.lng ?? null }
      const a = initial
        ? await api<Address>(`/api/addresses/${initial.id}`, { method: 'PUT', body })
        : await api<Address>('/api/addresses', { body })
      onSaved(a)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="stack-sm">
      <div className="chips">
        {['Home', 'Office', 'Other'].map((l) => (
          <button type="button" key={l} className={`chip ${f.label === l ? 'on' : ''}`} onClick={() => set('label', l)}>{l}</button>
        ))}
      </div>
      {config?.place_search && (
        <PlaceSearch
          near={{ lat: f.lat, lng: f.lng }}
          provider={config.place_search}
          onPick={(p) => {
            setF((x) => ({ ...x, lat: p.lat, lng: p.lng, line1: p.line1 || x.line1, line2: p.line2 || x.line2, landmark: p.landmark || x.landmark }))
            if (p.pincode) checkPin(p.pincode)
            toast(p.line1 ? 'Address filled. Add your flat / door number and check the pin.' : 'Address filled. Add your flat / house number and check the pin.', 'ok')
          }}
        />
      )}
      <button type="button" className="btn btn-ghost btn-sm locate-btn" onClick={locate} disabled={locating}>
        <IconPin size={16} /> {locating ? 'Finding you…' : f.lat ? 'Location pinned, update' : 'Use my current location'}
      </button>
      {SERVER_MODE && f.lat != null && f.lng != null && (
        <Suspense fallback={null}>
          <PinPicker lat={f.lat} lng={f.lng} onMove={(lat, lng) => setF((x) => ({ ...x, lat, lng }))} />
        </Suspense>
      )}
      <Field label="Flat / house no., building" name="line1" required minLength={3} value={f.line1} onChange={(e) => set('line1', e.target.value)} />
      <Field label="Street, area" name="line2" value={f.line2} onChange={(e) => set('line2', e.target.value)} />
      <Field label="Landmark" name="landmark" value={f.landmark} onChange={(e) => set('landmark', e.target.value)} />
      <Field
        label="Pincode"
        name="pincode"
        inputMode="numeric"
        maxLength={6}
        required
        value={f.pincode}
        onChange={(e) => checkPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
        error={pinState && !pinState.ok ? "Sorry, we don't deliver here yet" : undefined}
      />
      {pinState?.ok && <p className="ok small inline-icon"><IconCheck size={15} /> We deliver to {pinState.area}</p>}
      <PhoneInput id="contact_phone" label="Contact number for delivery (optional)" value={f.contact_phone} onChange={(v) => set('contact_phone', v)} required={false} />
      <label className="check">
        <input type="checkbox" checked={f.is_default} onChange={(e) => set('is_default', e.target.checked)} /> Make default
      </label>
      {err && <p className="error">{err}</p>}
      <div className="row gap">
        <button className="btn" disabled={busy || (pinState !== null && !pinState.ok)}>{busy ? 'Saving…' : 'Save address'}</button>
        {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
      </div>
    </form>
  )
}

export function AddressPicker({ addresses, value, onChange, onAdded }: { addresses: Address[]; value: string; onChange: (id: string) => void; onAdded: (a: Address) => void }) {
  const [adding, setAdding] = useState(addresses.length === 0)
  return (
    <div className="stack-sm">
      {addresses.map((a) => (
        <label key={a.id} className={`option ${value === a.id ? 'on' : ''}`}>
          <input type="radio" name="address" checked={value === a.id} onChange={() => onChange(a.id)} />
          <div>
            <strong>{a.label}</strong> {a.is_default && <span className="tag">Default</span>}
            <p className="muted small">{[a.line1, a.line2, a.landmark, a.area, a.pincode].filter(Boolean).join(', ')}</p>
          </div>
        </label>
      ))}
      {adding ? (
        <div className="card inset">
          <AddressForm
            onSaved={(a) => { onAdded(a); onChange(a.id); setAdding(false) }}
            onCancel={addresses.length ? () => setAdding(false) : undefined}
          />
        </div>
      ) : (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>+ Add new address</button>
      )}
    </div>
  )
}
