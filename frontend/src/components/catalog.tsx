import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { rupees } from '../lib'
import { useCart, useToast } from '../state'
import type { Product } from '../types'
import { IconCheck, IconRepeat, IconX } from './icons'
import ProductArt from './ProductArt'

/** One shelf item: a single product, or a pouch milk with several packet colours. */
export interface Item {
  key: string
  brand: string
  title: string
  image: string
  variants: Product[]
}

export function groupProducts(products: Product[]): Item[] {
  const items: Item[] = []
  const byGroup = new Map<string, Item>()
  for (const p of products) {
    if (!p.group) {
      items.push({ key: p.id, brand: p.brand, title: p.name, image: p.image, variants: [p] })
      continue
    }
    let it = byGroup.get(p.group)
    if (!it) {
      it = { key: p.group, brand: p.brand, title: 'Milk', image: p.image, variants: [] }
      byGroup.set(p.group, it)
      items.push(it)
    }
    it.variants.push(p)
  }
  return items
}

export const priceRange = (it: Item) => {
  const ps = it.variants.map((v) => v.price_paise)
  const lo = Math.min(...ps), hi = Math.max(...ps)
  return lo === hi ? rupees(lo) : `${rupees(lo)} – ${rupees(hi)}`
}

/** Packet colour chooser: swatch, colour name, variant and fat. */
export function PackPicker({ variants, value, onChange, size = 'md' }: { variants: Product[]; value: string; onChange: (id: string) => void; size?: 'md' | 'sm' }) {
  if (!variants[0]?.pack_color) return null
  return (
    <div className={`pack-picker pack-${size}`} role="radiogroup" aria-label="Packet colour">
      {variants.map((v) => (
        <button
          key={v.id}
          type="button"
          role="radio"
          aria-checked={v.id === value}
          className={`pack ${v.id === value ? 'on' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            onChange(v.id)
          }}
          title={`${v.pack_label} · ${v.name.replace(' Milk', '')}${v.fat ? ` · ${v.fat} fat` : ''}`}
        >
          <span className="pack-swatch" style={{ background: v.pack_color }}>
            {v.id === value && <IconCheck size={size === 'sm' ? 11 : 14} />}
          </span>
          {size === 'md' && (
            <span className="pack-text">
              <strong>{v.pack_label}</strong>
              <small>{v.name.replace(' Milk', '')}{v.fat ? ` · ${v.fat}` : ''}</small>
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

/** Colour dots shown on shelf cards. */
export function PackDots({ variants }: { variants: Product[] }) {
  if (variants.length < 2 || !variants[0].pack_color) return null
  return (
    <span className="pack-dots" aria-label={`${variants.length} packet colours`}>
      {variants.map((v) => <i key={v.id} style={{ background: v.pack_color }} />)}
    </span>
  )
}

/** Bottom sheet with photo, packet colour, quantity, add to cart / subscribe. */
export function ProductSheet({ item, initial, onClose }: { item: Item; initial?: string; onClose: () => void }) {
  const [sel, setSel] = useState(initial ?? item.variants[0].id)
  const [qty, setQty] = useState(1)
  const cart = useCart()
  const toast = useToast()
  const nav = useNavigate()
  const v = item.variants.find((x) => x.id === sel) ?? item.variants[0]
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal product-sheet" role="dialog" aria-modal="true" aria-label={`${item.brand} ${item.title}`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-photo">
          <ProductArt p={v} />
          {v.pack_color && <span className="sheet-pack" style={{ background: v.pack_color }}>{v.pack_label} packet</span>}
          <button className="icon-btn sheet-close" aria-label="Close" onClick={onClose}><IconX /></button>
        </div>
        <div className="sheet-body">
          <span className="brand-line">{item.brand}</span>
          <div className="row between">
            <h2 className="display-xs">{v.name}</h2>
            <span key={v.id} className="sheet-price">{rupees(v.price_paise)}</span>
          </div>
          <p className="muted small">{v.description} · {v.unit}</p>
          {v.pack_color && (
            <>
              <p className="label">{item.variants.length > 1 ? 'Choose packet colour' : 'Packet colour'}</p>
              <PackPicker variants={item.variants} value={sel} onChange={setSel} />
            </>
          )}
          <div className="sheet-actions">
            <div className="stepper">
              <button onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Decrease">−</button>
              <span>{qty}</span>
              <button onClick={() => setQty(Math.min(20, qty + 1))} aria-label="Increase">+</button>
            </div>
            <button
              className="btn btn-lg grow"
              onClick={() => {
                cart.add(v, qty)
                toast(`${item.brand === 'MooNest Farms' ? '' : item.brand + ' '}${v.name}${v.pack_label ? ` (${v.pack_label})` : ''} × ${qty} added`, 'ok')
                onClose()
              }}
            >
              Add · {rupees(v.price_paise * qty)}
            </button>
          </div>
          {v.subscribable && (
            <button className="btn btn-ghost btn-block inline-icon" onClick={() => nav(`/subscribe?product=${v.id}`)}>
              <IconRepeat size={16} /> Subscribe for daily delivery
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
