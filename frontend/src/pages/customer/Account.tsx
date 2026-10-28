import { FormEvent, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, SERVER_MODE } from '../../api'
import PushCard from '../../components/PushCard'
import { ConfirmButton, DemoBar, Field, Modal, PhoneInput } from '../../components/ui'
import { isValidPhone } from '../../lib'
import { useApi, useAuth, useToast } from '../../state'
import type { Address } from '../../types'
import { AddressForm } from './AddressPicker'

export default function Account() {
  const { user, refresh, logout } = useAuth()
  const toast = useToast()
  const addrs = useApi<Address[]>('/api/addresses')
  const [name, setName] = useState(user?.name ?? '')
  const [phone, setPhone] = useState(user?.phone ?? '')
  const [email, setEmail] = useState(user?.email ?? '')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Address | 'new' | null>(null)
  const [perm, setPerm] = useState<string>(() => { try { return typeof Notification !== 'undefined' ? Notification.permission : 'denied' } catch { return 'denied' } })

  useEffect(() => {
    setName(user?.name ?? '')
    setPhone(user?.phone ?? '')
    setEmail(user?.email ?? '')
  }, [user])

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (phone && !isValidPhone(phone)) return toast('Enter a valid 10-digit mobile number', 'bad')
    setBusy(true)
    try {
      await api('/api/auth/me', { method: 'PATCH', body: { name: name.trim() || undefined, phone: phone || undefined, email: email.trim() || undefined } })
      await refresh()
      toast('Profile saved', 'ok')
    } catch (e) {
      toast((e as Error).message, 'bad')
    } finally {
      setBusy(false)
    }
  }

  const setPref = async (missed_pref: string) => {
    try {
      await api('/api/auth/me', { method: 'PATCH', body: { missed_pref } })
      await refresh()
      toast('Preference saved', 'ok')
    } catch (e) {
      toast((e as Error).message, 'bad')
    }
  }

  const removeAddr = async (a: Address) => {
    try {
      await api(`/api/addresses/${a.id}`, { method: 'DELETE' })
      addrs.reload()
    } catch (e) {
      toast((e as Error).message, 'bad')
    }
  }

  return (
    <div className="stack">
      <h1>Account</h1>
      <form className="card stack-sm" onSubmit={save}>
        <h3>Profile</h3>
        <Field label="Name" name="name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <PhoneInput value={phone} onChange={setPhone} required={false} />
        <Field label="Email" name="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <button className="btn" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
      </form>

      <section className="card stack-sm">
        <div className="row between">
          <h3>Addresses</h3>
          <button className="btn btn-sm" onClick={() => setEditing('new')}>+ Add</button>
        </div>
        {addrs.data?.map((a) => (
          <div key={a.id} className="row between">
            <div>
              <strong>{a.label}</strong> {a.is_default && <span className="tag">Default</span>}
              <p className="muted small">{[a.line1, a.line2, a.area, a.pincode].filter(Boolean).join(', ')}</p>
            </div>
            <div className="row">
              <button className="link-btn" onClick={() => setEditing(a)}>Edit</button>
              <ConfirmButton className="link-btn bad" confirmLabel="Confirm delete" onConfirm={() => removeAddr(a)}>Delete</ConfirmButton>
            </div>
          </div>
        ))}
      </section>

      <section className="card stack-sm">
        <h3>If a delivery is missed</h3>
        {[
          { v: 'wallet_credit', t: 'Credit my wallet', d: 'Prepaid amount comes back to your wallet automatically (default)' },
          { v: 'redeliver', t: 'Redeliver next day', d: 'We bring it in the same slot the next day' },
        ].map((o) => (
          <label key={o.v} className={`option ${(user?.missed_pref ?? 'wallet_credit') === o.v ? 'on' : ''}`}>
            <input type="radio" name="missed" checked={(user?.missed_pref ?? 'wallet_credit') === o.v} onChange={() => setPref(o.v)} />
            <div><strong>{o.t}</strong><p className="muted small">{o.d}</p></div>
          </label>
        ))}
      </section>

      {SERVER_MODE ? <PushCard /> : (
        <section className="card stack-sm">
          <h3>Notifications</h3>
          <p className="muted small">Get alerts when your milk is on the way and when it's delivered. SMS alerts go to your mobile number.</p>
          {perm === 'granted' ? (
            <p className="ok small">Browser notifications are on</p>
          ) : (
            <button className="btn btn-ghost btn-sm" disabled={perm === 'denied'} onClick={async () => { try { setPerm(await Notification.requestPermission()) } catch { setPerm('denied') } }}>
              {perm === 'denied' ? 'Not available here: updates appear under the bell icon' : 'Turn on browser notifications'}
            </button>
          )}
        </section>
      )}

      <section className="card list">
        <Link to="/subscriptions" className="row between"><span>My subscriptions</span><span>→</span></Link>
        <Link to="/orders" className="row between"><span>My orders</span><span>→</span></Link>
        <Link to="/wallet" className="row between"><span>Wallet, payments & invoices</span><span>→</span></Link>
      </section>

      <DemoBar />
      <button className="btn btn-ghost btn-block" onClick={logout}>Log out</button>

      {editing && (
        <Modal title={editing === 'new' ? 'Add address' : 'Edit address'} onClose={() => setEditing(null)}>
          <AddressForm
            initial={editing === 'new' ? undefined : editing}
            onSaved={() => { setEditing(null); addrs.reload(); toast('Address saved', 'ok') }}
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}
    </div>
  )
}
