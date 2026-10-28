import { CSSProperties, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { IconArrowLeft, IconCheck, IconPhone, IconRepeat } from '../components/icons'
import { Badge } from '../components/ui'
import { useAuth } from '../state'

/**
 * Live tracking walkthrough: a scripted morning run on a drawn Koramangala street grid.
 * The agent drives the streets, drops at three stops, then delivers to you.
 * Real deliveries use the same screen fed by the agent's phone GPS.
 */

type Pt = { x: number; y: number }
const MAP_W = 400, MAP_H = 500
const ROUTE: Pt[] = [
  { x: 50, y: 60 }, { x: 50, y: 170 }, { x: 150, y: 170 }, { x: 250, y: 170 },
  { x: 250, y: 290 }, { x: 350, y: 290 }, { x: 350, y: 410 }, { x: 290, y: 410 },
]
const STOPS = [{ at: 2, name: 'Meera' }, { at: 4, name: 'Arjun' }, { at: 5, name: 'Lakshmi' }]
const HOME_AT = ROUTE.length - 1
const SPEED = 46 // px per second at 1×
const STOP_WAIT = 2.6
const START_CLOCK = 5 * 60 + 4 // 5:04 AM
const TRIP_MINUTES = 21

const H_STREETS = [{ y: 60, name: '1st Cross' }, { y: 170, name: '5th Cross' }, { y: 290, name: '100 Feet Rd', major: true }, { y: 410, name: '17th Cross' }]
const V_STREETS = [{ x: 50, name: '8th Main' }, { x: 150, name: '6th Main' }, { x: 250, name: '80 Feet Rd', major: true }, { x: 350, name: '4th Main' }]

/** The run as a list of legs: drive between route points, wait at stops. */
type Leg = { kind: 'drive'; from: number; dur: number } | { kind: 'wait'; at: number; dur: number }
const LEGS: Leg[] = []
for (let i = 0; i < ROUTE.length - 1; i++) {
  const a = ROUTE[i], b = ROUTE[i + 1]
  LEGS.push({ kind: 'drive', from: i, dur: Math.hypot(b.x - a.x, b.y - a.y) / SPEED })
  if (STOPS.some((s) => s.at === i + 1)) LEGS.push({ kind: 'wait', at: i + 1, dur: STOP_WAIT })
}
const TOTAL = LEGS.reduce((s, l) => s + l.dur, 0)

function stateAt(t: number) {
  let rest = Math.min(t, TOTAL)
  let pos: Pt = ROUTE[0], reached = 0, waiting = -1
  const trail: Pt[] = [ROUTE[0]]
  for (const l of LEGS) {
    if (l.kind === 'drive') {
      const a = ROUTE[l.from], b = ROUTE[l.from + 1]
      const f = Math.min(1, rest / l.dur)
      pos = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
      if (f < 1) { trail.push(pos); break }
      trail.push(b); reached = l.from + 1
    } else if (rest < l.dur) { waiting = l.at; break }
    rest -= l.dur
  }
  const done = STOPS.filter((s) => s.at < reached || (s.at === reached && waiting !== s.at)).length
  return { pos, trail, reached, waiting, done, delivered: t >= TOTAL }
}

const clock = (mins: number) => {
  const h = Math.floor(mins / 60), m = Math.floor(mins % 60)
  return `${h}:${String(m).padStart(2, '0')} AM`
}

export default function LiveDemo() {
  const nav = useNavigate()
  const { user } = useAuth()
  const [t, setT] = useState(-1.4) // short "leaving the hub" beat before driving
  const [speed, setSpeed] = useState(1)
  const [run, setRun] = useState(0)
  const last = useRef<number | null>(null)
  const speedRef = useRef(speed)
  speedRef.current = speed

  useEffect(() => {
    let raf = 0
    last.current = null
    const tick = (now: number) => {
      const dt = last.current == null ? 0 : (now - last.current) / 1000
      last.current = now
      setT((v) => (v >= TOTAL + 0.5 ? v : v + dt * speedRef.current))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [run])

  const s = stateAt(Math.max(0, t))
  const progress = Math.max(0, Math.min(1, t / TOTAL))
  const now = START_CLOCK + progress * TRIP_MINUTES
  const eta = Math.max(1, Math.ceil((1 - progress) * TRIP_MINUTES))
  const stopsLeft = STOPS.length - s.done
  const near = !s.delivered && s.reached >= STOPS[STOPS.length - 1].at && s.waiting < 0
  const started = t > 0
  const home = ROUTE[HOME_AT]
  const trailPts = [...s.trail.slice(0, -1), s.pos].map((p) => `${p.x},${p.y}`).join(' ')

  const replay = () => { setT(-1.4); setRun((r) => r + 1) }
  const headline = s.delivered
    ? 'Delivered'
    : !started ? 'Ravi is leaving the hub'
    : near ? 'Ravi is almost at your door'
    : s.waiting >= 0 ? `Ravi is dropping milk at stop ${STOPS.findIndex((x) => x.at === s.waiting) + 1}`
    : 'Ravi is on the way'
  const steps = [
    { label: 'Packed', time: '4:55 AM', on: true },
    { label: 'Out for delivery', time: clock(START_CLOCK), on: started },
    { label: 'Nearby', time: near || s.delivered ? clock(START_CLOCK + TRIP_MINUTES - 3) : '', on: near || s.delivered },
    { label: 'Delivered', time: s.delivered ? clock(START_CLOCK + TRIP_MINUTES) : '', on: s.delivered },
  ]

  return (
    <div className="live-demo">
      <header className="ld-top">
        <button className="icon-btn" aria-label="Back" onClick={() => (user ? nav(-1) : nav('/welcome'))}><IconArrowLeft /></button>
        <div className="grow">
          <span className="eyebrow">Live tracking</span>
          <strong className="ld-clock">{clock(now)} · Koramangala</strong>
        </div>
        <Badge tone="ok">{s.delivered ? 'Done' : '● Live'}</Badge>
      </header>

      <section className={`card ld-status ${s.delivered ? 'is-done' : ''}`}>
        <div className="row between">
          <div className="grow">
            <h2 className="display-xs" aria-live="polite">{headline}</h2>
            <p className="muted small">
              {s.delivered
                ? `Left at your door at ${clock(START_CLOCK + TRIP_MINUTES)}`
                : `${stopsLeft ? `${stopsLeft} stop${stopsLeft === 1 ? '' : 's'} before you` : 'You are next'} · Aavin Nice Toned × 2`}
            </p>
          </div>
          {!s.delivered && (
            <div className="ld-eta">
              <strong key={eta}>{eta}</strong>
              <span>min</span>
            </div>
          )}
          {s.delivered && <span className="ld-check"><IconCheck size={26} /></span>}
        </div>
        <ol className="ld-steps">
          {steps.map((st) => (
            <li key={st.label} className={st.on ? 'on' : ''}>
              <i />
              <span>{st.label}</span>
              <small>{st.time}</small>
            </li>
          ))}
        </ol>
      </section>

      <div className="map ld-map">
        <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Map showing the milk agent's route to your home">
          <rect width={MAP_W} height={MAP_H} className="ld-ground" />
          <rect x="162" y="72" width="76" height="86" rx="10" className="ld-park" />
          <text x="200" y="119" textAnchor="middle" className="ld-park-label">Park</text>
          <ellipse cx="100" cy="352" rx="36" ry="40" className="ld-water" />
          {H_STREETS.map((st) => <line key={st.name} x1="0" x2={MAP_W} y1={st.y} y2={st.y} className={st.major ? 'ld-road' : 'ld-street'} />)}
          {V_STREETS.map((st) => <line key={st.name} y1="0" y2={MAP_H} x1={st.x} x2={st.x} className={st.major ? 'ld-road' : 'ld-street'} />)}
          {H_STREETS.map((st) => <text key={st.name} x={62} y={st.y - 11} className="ld-street-name">{st.name}</text>)}
          {V_STREETS.map((st) => <text key={st.name} transform={`translate(${st.x + 14} ${MAP_H - 8}) rotate(-90)`} className="ld-street-name">{st.name}</text>)}

          <polyline points={ROUTE.map((p) => `${p.x},${p.y}`).join(' ')} className="ld-route" />
          <polyline points={trailPts} className="ld-trail" />

          <g transform={`translate(${ROUTE[0].x} ${ROUTE[0].y})`} className="ld-hub">
            <rect x="-15" y="-15" width="30" height="30" rx="8" />
            <text y="1" textAnchor="middle" dominantBaseline="central">M</text>
            <text x="22" y="1" dominantBaseline="central" className="ld-pin-name">MooNest hub</text>
          </g>
          {STOPS.map((st, i) => {
            const p = ROUTE[st.at]
            const done = i < s.done
            return (
              <g key={st.name} transform={`translate(${p.x} ${p.y})`} className={`ld-stop ${done ? 'done' : ''} ${s.waiting === st.at ? 'now' : ''}`}>
                <circle r="13" />
                {done ? <path d="M-5 0l3.5 3.5L5.5-4" className="ld-tick" /> : <text textAnchor="middle" dominantBaseline="central">{i + 1}</text>}
              </g>
            )
          })}
          <g transform={`translate(${home.x} ${home.y})`} className={`ld-home ${s.delivered ? 'done' : ''}`}>
            <circle r="24" className="ld-home-halo" />
            <circle r="16" />
            <g transform="translate(-9 -10) scale(0.78)" className="pin-glyph">
              <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
            </g>
            <text y="-30" textAnchor="middle" className="ld-pin-name">You</text>
          </g>

          {!s.delivered && (
            <g transform={`translate(${s.pos.x} ${s.pos.y})`} className="ld-agent">
              <circle r="30" className="ld-pulse" />
              <circle r="17" />
              <g transform="translate(-10 -10) scale(0.84)" className="pin-glyph">
                <path d="M14 18V6H2v12h2" /><path d="M14 9h4l4 4v5h-2" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /><path d="M9 18h6" />
              </g>
              <text y="33" textAnchor="middle" className="ld-pin-name">Ravi</text>
            </g>
          )}
        </svg>
        {near && <div className="ld-toast">Ravi is 2 min away. Keep the gate open.</div>}
      </div>

      <section className="card ld-agent-card">
        <span className="ld-avatar">RK</span>
        <div className="grow">
          <strong>Ravi Kumar</strong>
          <p className="muted small">Your milk agent · 4.9 ★ · 1,240 deliveries</p>
        </div>
        <button className="icon-btn" aria-label="Call Ravi (demo)" onClick={() => undefined}><IconPhone size={18} /></button>
      </section>

      <div className="ld-controls">
        <div className="seg seg-sm" style={{ '--n': 2, '--i': speed === 1 ? 0 : 1 } as CSSProperties}>
          <button className={speed === 1 ? 'on' : ''} onClick={() => setSpeed(1)}>1×</button>
          <button className={speed === 3 ? 'on' : ''} onClick={() => setSpeed(3)}>3× speed</button>
        </div>
        <button className="btn btn-ghost inline-icon" onClick={replay}><IconRepeat size={16} /> Replay</button>
      </div>
      <p className="muted small center">Demo route. On real deliveries this screen follows the agent's phone GPS, updated every few seconds.</p>
    </div>
  )
}
