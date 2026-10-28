/**
 * "Move the map to your gate": the pin stays in the middle and the customer drags the map under it,
 * the way delivery apps do it. Reports the new centre when the map stops moving. Server build only.
 */
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'

const TILES = import.meta.env.VITE_MAP_TILES || 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png'
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'

export default function PinPicker({ lat, lng, onMove, height = 220 }: { lat: number; lng: number; onMove: (lat: number, lng: number) => void; height?: number }) {
  const el = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const report = useRef(onMove)
  report.current = onMove

  useEffect(() => {
    const m = L.map(el.current!, { zoomControl: true, attributionControl: true, scrollWheelZoom: 'center', touchZoom: 'center' })
    L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 20, subdomains: 'abcd' }).addTo(m)
    m.setView([lat, lng], 18)
    m.on('moveend', () => {
      const c = m.getCenter()
      report.current(Number(c.lat.toFixed(6)), Number(c.lng.toFixed(6)))
    })
    map.current = m
    return () => {
      m.remove()
      map.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // A new position from outside (search pick, GPS) re-centres the map; one the map itself reported is already there
  useEffect(() => {
    const m = map.current
    if (!m || m.getCenter().distanceTo([lat, lng]) < 2) return
    m.setView([lat, lng], Math.max(m.getZoom(), 17), { animate: false })
  }, [lat, lng])

  return (
    <div className="pin-picker" style={{ height }}>
      <div ref={el} className="map live-map" style={{ height }} role="application" aria-label="Map: drag it so the pin sits on your gate" />
      <div className="pin-picker-pin" aria-hidden="true" />
      <p className="pin-picker-hint">Drag the map so the pin sits on your gate</p>
    </div>
  )
}
