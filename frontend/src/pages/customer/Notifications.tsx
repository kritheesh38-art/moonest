import { useEffect } from 'react'
import { assetUrl, api } from '../../api'
import { Empty, Spinner } from '../../components/ui'
import { fmtDate, fmtTime } from '../../lib'
import { useApi } from '../../state'
import type { Notification } from '../../types'

export default function Notifications({ onRead }: { onRead: () => void }) {
  const { data, loading } = useApi<Notification[]>('/api/notifications')
  useEffect(() => {
    if (data?.some((n) => !n.read)) api('/api/notifications/read', { method: 'POST' }).then(onRead).catch(() => null)
  }, [data, onRead])
  if (loading) return <Spinner />
  if (!data?.length) return <Empty title="No notifications yet">Delivery updates and payment alerts show up here.</Empty>
  return (
    <div className="stack">
      <h1>Notifications</h1>
      {data.map((n) => (
        <div key={n.id} className={`card notif ${n.read ? '' : 'unread'}`}>
          <div className="row between">
            <strong>{n.title}</strong>
            <span className="muted small">{fmtDate(n.created_at, { day: 'numeric', month: 'short' })} {fmtTime(n.created_at)}</span>
          </div>
          <p>{n.body}</p>
          {n.image_url && <img className="proof" src={assetUrl(n.image_url)} alt="Delivery proof" />}
        </div>
      ))}
    </div>
  )
}
