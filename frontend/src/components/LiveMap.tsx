/**
 * Real street map for the server build: OpenStreetMap data via CARTO tiles (free, no key), the
 * agent's live position, and the driving route to the customer from the public OSRM router.
 * Loaded on demand, never in the claude.ai build (its page can't load map tiles).
 */
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'
import type { MapPoint } from './MapView'

const TILES = import.meta.env.VITE_MAP_TILES || 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
const ROUTER = import.meta.env.VITE_ROUTER_URL ?? 'https://router.project-osrm.org/route/v1/driving'

const GLYPH: Record<string, string> = {
  agent: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 18V6H2v12h2"/><path d="M14 9h4l4 4v5h-2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/><path d="M9 18h6"/></svg>',
  home: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/></svg>',
}

const icon = (p: MapPoint) =>
  L.divIcon({
    className: '',
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    html: `<div class="lm-pin lm-${p.kind}${p.stale ? ' lm-stale' : ''}">${GLYPH[p.kind] ?? `<b>${p.label ?? ''}</b>`}</div>${
      p.kind === 'agent' && p.label ? `<span class="lm-label">${p.label.replace(/</g, '&lt;')}</span>` : ''
    }`,
  })

/** Road route between two points, or null (then a straight dashed line is drawn). */
const routeCache = new Map<string, [number, number][]>()
async function roadRoute(a: MapPoint, b: MapPoint): Promise<[number, number][] | null> {
  if (!ROUTER) return null
  const key = [a.lat, a.lng, b.lat, b.lng].map((v) => v.toFixed(3)).join(',') // ~100 m: don't re-ask on every GPS fix
  if (routeCache.has(key)) return routeCache.get(key)!
  try {
    const r = await fetch(`${ROUTER}/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`)
    if (!r.ok) return null
    const coords: [number, number][] | undefined = (await r.json()).routes?.[0]?.geometry?.coordinates
    if (!coords?.length) return null
    const line = coords.map(([lng, lat]) => [lat, lng] as [number, number])
    routeCache.set(key, line)
    return line
  } catch {
    return null
  }
}

export default function LiveMap({ points, line, height = 300, follow }: { points: MapPoint[]; line?: boolean; height?: number; follow?: boolean }) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)
  const markers = useRef(new Map<string, L.Marker>())
  const looks = useRef(new Map<string, string>())
  const fitted = useRef(false)

  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: true, attributionControl: true, scrollWheelZoom: false })
    L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19, subdomains: 'abcd' }).addTo(m)
    m.setView([12.9352, 77.6245], 14)
    layer.current = L.layerGroup().addTo(m)
    map.current = m
    const ms = markers.current
    return () => {
      m.remove()
      map.current = null
      ms.clear()
      fitted.current = false
    }
  }, [])

  // Markers move smoothly to each new position instead of being redrawn
  useEffect(() => {
    const m = map.current
    if (!m) return
    const seen = new Set<string>()
    for (const p of points) {
      seen.add(p.id)
      const ex = markers.current.get(p.id)
      const look = `${p.kind}|${p.stale ? 1 : 0}|${p.label ?? ''}`
      if (ex) {
        ex.setLatLng([p.lat, p.lng]) // moves (and glides) the same marker
        if (looks.current.get(p.id) !== look) ex.setIcon(icon(p)) // rebuild only when its look changes
      } else markers.current.set(p.id, L.marker([p.lat, p.lng], { icon: icon(p), keyboard: false, zIndexOffset: p.kind === 'agent' ? 1000 : 0 }).addTo(m))
      looks.current.set(p.id, look)
    }
    for (const [id, mk] of markers.current) if (!seen.has(id)) (mk.remove(), markers.current.delete(id), looks.current.delete(id))
    if (points.length && (follow || !fitted.current)) {
      const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number]))
      m.fitBounds(bounds, { padding: [48, 48], maxZoom: 16, animate: fitted.current })
      fitted.current = true
    }
  }, [points, follow])

  // Route line: road route from the agent to the customer when there are exactly those two points
  useEffect(() => {
    const lg = layer.current
    if (!lg) return
    let cancelled = false
    lg.clearLayers()
    if (!line || points.length < 2) return
    const straight = L.polyline(points.map((p) => [p.lat, p.lng] as [number, number]), { color: '#2f6b4f', weight: 3, dashArray: '6 8', opacity: 0.7 })
    straight.addTo(lg)
    const agent = points.find((p) => p.kind === 'agent'), home = points.find((p) => p.kind === 'home')
    if (agent && home && points.length === 2)
      roadRoute(agent, home).then((road) => {
        if (cancelled || !road) return
        lg.clearLayers()
        L.polyline(road, { color: '#2f6b4f', weight: 5, opacity: 0.85 }).addTo(lg)
      })
    return () => {
      cancelled = true
    }
  }, [points, line])

  return <div ref={el} className="map live-map" style={{ height }} role="img" aria-label="Live map of the delivery" />
}
