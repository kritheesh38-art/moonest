/**
 * Small, dependency-free charts for the Admin dashboard (single series, so no legend: the title
 * names it). Columns ≤ 24px with a 4px rounded top and a square baseline, hairline grid, a tooltip
 * on hover and keyboard focus (← → move between days), and a table view for every chart.
 */
import { useId, useLayoutEffect, useRef, useState } from 'react'

export interface Point {
  key: string
  label: string // shown on the axis / tooltip, e.g. "28 Oct"
  value: number
}

function niceMax(v: number) {
  if (v <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}

const compact = (n: number) => (n >= 1e7 ? `${+(n / 1e7).toFixed(1)}Cr` : n >= 1e5 ? `${+(n / 1e5).toFixed(1)}L` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}K` : `${+n.toFixed(1)}`)

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(600)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, e.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/** Column chart over days. `format` writes values for ticks, tooltip and table; `tick` (optional) for the axis. */
export function ColumnChart({ title, points, format, tick = compact, height = 180, whole = false }: { title: string; points: Point[]; format: (v: number) => string; tick?: (v: number) => string; height?: number; whole?: boolean }) {
  const [box, width] = useWidth<HTMLDivElement>()
  const [active, setActive] = useState<number | null>(null)
  const id = useId()
  const pad = { l: 40, r: 8, t: 10, b: 24 }
  const iw = width - pad.l - pad.r
  const ih = height - pad.t - pad.b
  const top = niceMax(Math.max(...points.map((p) => p.value), 0))
  const max = whole ? Math.max(2, Math.ceil(top / 2) * 2) : top // whole numbers: an even top keeps the middle tick whole
  const slot = iw / Math.max(points.length, 1)
  const bw = Math.min(24, Math.max(2, slot - 2)) // ≤ 24px, with at least a 2px surface gap
  const y = (v: number) => pad.t + ih - (v / max) * ih
  const ticks = [0, max / 2, max].filter((t) => !whole || Number.isInteger(t)) // counts never get a 2.5 tick
  const every = Math.ceil(points.length / Math.max(2, Math.floor(iw / 64))) // x labels that fit
  const total = points.reduce((a, p) => a + p.value, 0)
  const a = active != null ? points[active] : null

  const bar = (v: number, x: number) => {
    const h = Math.max(0, (v / max) * ih)
    if (h <= 0) return ''
    const r = Math.min(4, h, bw / 2)
    const top = pad.t + ih - h
    const base = pad.t + ih
    return `M${x},${base}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${base}Z`
  }

  return (
    <figure className="chart" aria-labelledby={`${id}-t`}>
      <figcaption id={`${id}-t`} className="chart-title">{title}<span className="chart-total">{format(total)} in total</span></figcaption>
      <div className="chart-box" ref={box} onPointerLeave={() => setActive(null)}>
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${title}: ${points.length} days, ${format(total)} in total. Use left and right arrows to read each day.`}
          tabIndex={0}
          onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
              e.preventDefault()
              setActive((i) => Math.min(points.length - 1, Math.max(0, (i ?? points.length) + (e.key === 'ArrowRight' ? 1 : -1))))
            }
          }}
          onFocus={() => setActive((i) => i ?? points.length - 1)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className="chart-grid" />
              <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="chart-axis">{tick(t)}</text>
            </g>
          ))}
          {points.map((p, i) => {
            const x = pad.l + i * slot + (slot - bw) / 2
            return (
              <g key={p.key} onPointerEnter={() => setActive(i)} onPointerDown={() => setActive(i)}>
                <rect x={pad.l + i * slot} y={pad.t} width={slot} height={ih} fill="transparent" />
                <path d={bar(p.value, x)} className={`chart-bar${active === i ? ' on' : ''}`} />
                {i % every === (points.length - 1) % every && (
                  <text x={x + bw / 2} y={height - 6} textAnchor="middle" className="chart-axis">{p.label}</text>
                )}
              </g>
            )
          })}
        </svg>
        {a && active != null && (
          <div className="chart-tip" style={{ left: Math.min(width - 120, Math.max(0, pad.l + active * slot + slot / 2 - 60)) }} role="status">
            <strong>{format(a.value)}</strong>
            <span>{a.label}</span>
          </div>
        )}
      </div>
      <details className="chart-table">
        <summary>Show as table</summary>
        <table>
          <thead><tr><th scope="col">Day</th><th scope="col" className="num">{title}</th></tr></thead>
          <tbody>{points.map((p) => <tr key={p.key}><th scope="row">{p.label}</th><td className="num">{format(p.value)}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  )
}

/** Horizontal bars for a ranking (e.g. litres per brand), value at each bar's tip. */
export function BarList({ title, rows, format }: { title: string; rows: { label: string; value: number }[]; format: (v: number) => string }) {
  const max = Math.max(...rows.map((r) => r.value), 0) || 1
  return (
    <figure className="chart">
      <figcaption className="chart-title">{title}</figcaption>
      {!rows.length ? <p className="muted small">No deliveries in this period yet.</p> : (
        <ul className="barlist">
          {rows.map((r) => (
            <li key={r.label} title={`${r.label}: ${format(r.value)}`}>
              <span className="barlist-label">{r.label}</span>
              <span className="barlist-track">
                <span className="barlist-bar" style={{ width: `${Math.max(1, (r.value / max) * 100)}%` }} />
                <span className="barlist-value">{format(r.value)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  )
}
