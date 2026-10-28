import { CSSProperties, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { groupProducts, Item, PackPicker, ProductSheet } from '../../components/catalog'
import { IconPlus } from '../../components/icons'
import ProductArt from '../../components/ProductArt'
import { ErrorBox, Spinner } from '../../components/ui'
import { rupees } from '../../lib'
import { useApi, useCart, useToast } from '../../state'
import type { Product } from '../../types'

/** Shop card: pick the packet colour right on the card; + adds the chosen packet. */
export function ShelfCard({ it, onOpen }: { it: Item; onOpen: (variantId: string) => void }) {
  const [sel, setSel] = useState(it.variants[0].id)
  const cart = useCart()
  const toast = useToast()
  const v = it.variants.find((x) => x.id === sel) ?? it.variants[0]
  const inCart = cart.lines.find((l) => l.product.id === v.id)
  return (
    <article className="shelf-card" onClick={() => onOpen(v.id)} role="button" tabIndex={0} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget && onOpen(v.id)} aria-label={`${it.brand} ${v.name}`}>
      <div className="shelf-img">
        <ProductArt key={v.id} p={v} className="swap-in" />
        {v.pack_label ? (
          <span className="img-badge pack-badge"><i style={{ background: v.pack_color }} />{v.pack_label} packet</span>
        ) : (
          v.tags[0] && <span className="img-badge">{v.tags[0]}</span>
        )}
        <button
          className={`add-fab ${inCart ? 'has' : ''}`}
          aria-label={`Add ${it.brand} ${v.name}${v.pack_label ? `, ${v.pack_label} packet` : ''} to cart`}
          onClick={(e) => {
            e.stopPropagation()
            cart.add(v)
            toast(`${it.brand} ${v.name}${v.pack_label ? ` (${v.pack_label})` : ''} added`, 'ok')
          }}
        >
          {inCart ? inCart.qty : <IconPlus size={18} />}
        </button>
      </div>
      <div className="shelf-body">
        <span className="brand-line">{it.brand}</span>
        <h3>{v.name}</h3>
        <p className="muted small">{v.description}</p>
        <div onClick={(e) => e.stopPropagation()}>
          <PackPicker variants={it.variants} value={v.id} onChange={setSel} size="sm" />
        </div>
        <div className="row between">
          <span key={v.id} className="price price-swap">{rupees(v.price_paise)}</span>
          <span className="muted small">{v.unit}</span>
        </div>
      </div>
    </article>
  )
}

const CATS = [
  { key: 'milk', label: 'Milk' },
  { key: 'dairy', label: 'Curd, paneer & more' },
]

export default function Shop() {
  const { data, error, loading, reload } = useApi<Product[]>('/api/products')
  const [params, setParams] = useSearchParams()
  const [open, setOpen] = useState<{ item: Item; initial: string } | null>(null)
  const brand = params.get('brand')
  const type = params.get('type')
  if (loading) return <Spinner />
  if (error) return <ErrorBox message={error} onRetry={reload} />
  // a brand link with no category opens wherever that brand has products (Amul is dairy only)
  const cat = params.get('cat') === 'dairy' || (!params.get('cat') && brand && !(data ?? []).some((p) => p.brand === brand && p.category !== 'dairy')) ? 'dairy' : 'milk'
  const inCat = (data ?? []).filter((p) => (cat === 'dairy') === (p.category === 'dairy'))
  const brands = [...new Set(inCat.map((p) => p.brand))]
  const types = cat === 'dairy' ? [...new Set(inCat.map((p) => p.tags[0]).filter(Boolean))] : []
  const items = groupProducts(inCat.filter((p) => (!brand || p.brand === brand) && (!type || p.tags[0] === type)))
  const go = (next: Record<string, string | null>) => {
    const q: Record<string, string> = {}
    for (const [k, v] of Object.entries({ cat: cat === 'dairy' ? 'dairy' : null, brand, type, ...next })) if (v) q[k] = v
    setParams(q)
  }
  return (
    <div className="stack">
      <div>
        <span className="eyebrow">Delivered by 5:30 AM</span>
        <h1>{cat === 'dairy' ? 'Dairy' : 'Milk'}</h1>
        <p className="muted">{cat === 'dairy' ? 'Curd, paneer, butter, cheese and ghee from the brands you trust.' : 'Pick your brand, then your packet colour.'}</p>
      </div>
      <div className="seg cat-seg" role="tablist" aria-label="Category" style={{ '--n': CATS.length, '--i': cat === 'dairy' ? 1 : 0 } as CSSProperties}>
        {CATS.map((c) => (
          <button key={c.key} role="tab" aria-selected={cat === c.key} className={cat === c.key ? 'on' : ''} onClick={() => setParams(c.key === 'dairy' ? { cat: 'dairy' } : {})}>{c.label}</button>
        ))}
      </div>
      <div className="brand-strip">
        <button className={`brand-pill ${!brand ? 'on' : ''}`} onClick={() => go({ brand: null })}>All brands</button>
        {brands.map((b) => (
          <button key={b} className={`brand-pill ${brand === b ? 'on' : ''}`} onClick={() => go({ brand: b })}>{b}</button>
        ))}
      </div>
      {types.length > 1 && (
        <div className="brand-strip type-strip">
          <button className={`type-pill ${!type ? 'on' : ''}`} onClick={() => go({ type: null })}>All</button>
          {types.map((t) => (
            <button key={t} className={`type-pill ${type === t ? 'on' : ''}`} onClick={() => go({ type: t })}>{t}</button>
          ))}
        </div>
      )}
      {items.length ? (
        <div className="shelf">
          {items.map((it) => <ShelfCard key={it.key} it={it} onOpen={(initial) => setOpen({ item: it, initial })} />)}
        </div>
      ) : (
        <p className="muted">Nothing here yet. Try another brand.</p>
      )}
      {open && <ProductSheet item={open.item} initial={open.initial} onClose={() => setOpen(null)} />}
    </div>
  )
}
