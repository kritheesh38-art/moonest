import { useEffect, useState } from 'react'
import { IconCheck } from '../../components/icons'
import { Link } from 'react-router-dom'
import { assetUrl, openLiveSocket, SERVER_MODE } from '../../api'
import MapView, { MapPoint } from '../../components/MapView'
import { Badge, Empty, Spinner } from '../../components/ui'
import { fmtTime } from '../../lib'
import { useApi, useAuth } from '../../state'
import type { Tracking } from '../../types'

export default function Track() {
  const { data, loading, reload, setData } = useApi<Tracking[]>('/api/tracking/today')
  const { config } = useAuth()
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    const t = setInterval(reload, 15_000) // updates arrive live; this keeps "signal lost" ages fresh
    return () => clearInterval(t)
  }, [reload])
  const current = data?.[idx]
  // Server build: the agent's position arrives over a live connection the moment it's sent
  // (the regular refresh keeps working as a fallback).
  const liveId = SERVER_MODE && current?.status === 'pending' ? current.delivery_id : null
  useEffect(() => {
    if (!liveId) return
    let ws: WebSocket | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let closed = false
    const open = () => {
      ws = openLiveSocket(`/api/ws/track/${liveId}`)
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data)
        if (m.type === 'tracking') setData((d) => d?.map((x) => (x.delivery_id === m.delivery_id ? { ...x, ...m, items: x.items } : x)) ?? d)
      }
      ws.onclose = () => {
        if (!closed) retry = setTimeout(open, 5000)
      }
    }
    open()
    const ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send('ping'), 15000)
    return () => {
      closed = true
      clearInterval(ping)
      clearTimeout(retry)
      ws?.close()
    }
  }, [liveId, setData])
  const t = current
  const connected = true

  if (loading && !data) return <Spinner />
  if (!data?.length)
    return (
      <Empty title="No delivery today" action={<div className="row gap wrap center-row">{config?.demo_mode && <Link to="/live-demo" className="btn">Watch a live demo</Link>}<Link to="/subscriptions" className="btn btn-ghost">View subscriptions</Link></div>}>
        On delivery days you'll see your milk agent live on the map here.
      </Empty>
    )
  const tr = t ?? current!
  const points: MapPoint[] = []
  if (tr.location) points.push({ id: 'agent', lat: tr.location.lat, lng: tr.location.lng, kind: 'agent', label: tr.agent?.name, stale: tr.signal === 'lost' })
  if (tr.destination.lat != null) points.push({ id: 'home', lat: tr.destination.lat!, lng: tr.destination.lng!, kind: 'home', label: 'You' })

  return (
    <div className="stack">
      <h1>Live tracking</h1>
      {data.length > 1 && (
        <div className="segmented">
          {data.map((d, i) => (
            <button key={d.delivery_id} className={i === idx ? 'on' : ''} onClick={() => setIdx(i)}>{d.items?.[0]?.name ?? (d.slot === 'morning' ? 'Morning' : 'Evening')}</button>
          ))}
        </div>
      )}

      {tr.status === 'delivered' ? (
        <div className="card success-card">
          <div className="big-check"><IconCheck size={30} /></div>
          <h2>Delivered{tr.delivered_at ? ` at ${fmtTime(tr.delivered_at)}` : ''}</h2>
          {tr.photo_url && <img className="proof" src={assetUrl(tr.photo_url)} alt="Delivery proof" />}
        </div>
      ) : tr.status !== 'pending' ? (
        <div className="card"><p>This delivery was marked <strong>{tr.status}</strong>. Check notifications for details.</p></div>
      ) : (
        <>
          <div className="card">
            <div className="row between">
              <div>
                <h3>{tr.trip_status === 'active' ? `${tr.agent?.name ?? 'Your milk agent'} is on the way` : 'Waiting for the trip to start'}</h3>
                <p className="muted small">
                  {tr.trip_status === 'active'
                    ? tr.eta_minutes
                      ? `Arriving in ~${tr.eta_minutes} min · ${tr.stops_before_you} stop${tr.stops_before_you === 1 ? '' : 's'} before you`
                      : 'Calculating ETA…'
                    : `Scheduled for ${tr.slot === 'morning' ? '5:30 AM' : '5:00 PM'}`}
                </p>
              </div>
              {tr.trip_status === 'active' && (
                tr.signal === 'live' ? <Badge tone="ok">● Live</Badge> : <Badge tone="warn">Signal weak</Badge>
              )}
            </div>
            {tr.signal === 'lost' && tr.location && (
              <p className="notice">Agent's signal dropped. Showing last known location from {fmtTime(tr.location.ts)}.</p>
            )}
          </div>
          {points.length > 0 && <MapView points={points} line follow height={360} />}
          {tr.trip_status !== 'active' && config?.demo_mode && <Link to="/live-demo" className="link small">See how live tracking looks →</Link>}
          <p className="muted small">{connected && tr.location ? `Location updated ${fmtTime(tr.location.ts)}${(tr.location as { simulated?: boolean }).simulated ? ' · demo GPS' : ''}` : 'Waiting for the first location update…'}</p>
        </>
      )}
      {tr.items && (
        <div className="card">
          <h3>In this delivery</h3>
          {tr.items.map((i) => <p key={i.product_id}>{i.name} ({i.unit}) × {i.qty}</p>)}
        </div>
      )}
    </div>
  )
}
