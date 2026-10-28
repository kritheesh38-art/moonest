import { lazy, Suspense } from 'react'
import { SERVER_MODE } from '../api'

export interface MapPoint {
  id: string
  lat: number
  lng: number
  kind: 'agent' | 'home' | 'stop' | 'done'
  label?: string
  stale?: boolean
}

const W = 600

type Props = { points: MapPoint[]; line?: boolean; height?: number; follow?: boolean }

/** Real street map (loaded only in the server build). */
const LiveMap = lazy(() => import('./LiveMap'))

/** The server build shows a real street map; the claude.ai page can't load map tiles, so it draws one. */
export default function MapView(props: Props) {
  if (!props.points.length) return null
  if (!SERVER_MODE) return <DrawnMap {...props} />
  return (
    <Suspense fallback={<DrawnMap {...props} />}>
      <LiveMap {...props} />
    </Suspense>
  )
}

/**
 * Self-drawn map. Points are projected onto a neighbourhood grid with a scale bar, so distances
 * and the agent's movement read correctly.
 */
function DrawnMap({ points, line, height = 300 }: Props) {
  const H = Math.round((W * height) / 360)
  if (!points.length) return null
  const lats = points.map((p) => p.lat), lngs = points.map((p) => p.lng)
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2
  const kx = Math.cos((midLat * Math.PI) / 180) // longitude shrink at this latitude
  // extent in km-ish units, padded, never smaller than ~600 m so a single point still has context
  const spanX = Math.max((Math.max(...lngs) - Math.min(...lngs)) * kx, 0.006)
  const spanY = Math.max(Math.max(...lats) - Math.min(...lats), 0.006)
  const scale = Math.min((W * 0.78) / spanX, (H * 0.72) / spanY)
  const cx = ((Math.min(...lngs) + Math.max(...lngs)) / 2) * kx
  const cy = midLat
  const x = (p: { lng: number }) => W / 2 + (p.lng * kx - cx) * scale
  const y = (p: { lat: number }) => H / 2 - (p.lat - cy) * scale
  const kmPerUnit = 111.32
  const barKm = [0.1, 0.2, 0.5, 1, 2, 5].find((k) => (k / kmPerUnit) * scale > 60) ?? 5
  const barPx = (barKm / kmPerUnit) * scale
  const grid = Math.max(24, (0.25 / kmPerUnit) * scale) // a block every ~250 m

  return (
    <div className="map" style={{ height }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Map of the delivery route">
        <defs>
          <pattern id="blocks" width={grid} height={grid} patternUnits="userSpaceOnUse">
            <rect width={grid} height={grid} className="map-block" />
            <path d={`M ${grid} 0 L 0 0 0 ${grid}`} className="map-street" />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#blocks)" />
        <path d={`M 0 ${H * 0.62} C ${W * 0.3} ${H * 0.5}, ${W * 0.6} ${H * 0.8}, ${W} ${H * 0.66}`} className="map-road" />
        <path d={`M ${W * 0.28} 0 C ${W * 0.34} ${H * 0.4}, ${W * 0.22} ${H * 0.7}, ${W * 0.3} ${H}`} className="map-road" />
        {line && points.length > 1 && (
          <polyline points={points.map((p) => `${x(p)},${y(p)}`).join(' ')} className="map-line" />
        )}
        {points.map((p) => (
          <g key={p.id} transform={`translate(${x(p)} ${y(p)})`} className={`pin pin-${p.kind}${p.stale ? ' pin-stale' : ''}`}>
            <circle r={17} />
            {p.kind === 'agent' ? (
              <g transform="translate(-10 -10) scale(0.84)" className="pin-glyph">
                <path d="M14 18V6H2v12h2" /><path d="M14 9h4l4 4v5h-2" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /><path d="M9 18h6" />
              </g>
            ) : p.kind === 'home' ? (
              <g transform="translate(-10 -10) scale(0.84)" className="pin-glyph">
                <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
              </g>
            ) : (
              <text textAnchor="middle" dominantBaseline="central" fontSize={13}>{p.label}</text>
            )}
            {p.kind === 'agent' && p.label && (
              <text y={30} textAnchor="middle" className="pin-label">{p.label}</text>
            )}
          </g>
        ))}
        <g transform={`translate(14 ${H - 18})`} className="map-scale">
          <path d={`M 0 -6 V 0 H ${barPx} V -6`} />
          <text x={barPx + 6} y={0}>{barKm < 1 ? `${barKm * 1000} m` : `${barKm} km`}</text>
        </g>
      </svg>
    </div>
  )
}
