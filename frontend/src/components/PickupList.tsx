/** Packets to collect from the dairy: one row per product (brand, packet colour, size), morning and
 *  evening counts, and the totals. Shared by the agent app and Admin → Routes. */
export interface PickupItem {
  product_id: string
  brand: string
  name: string
  unit: string
  pack_label?: string | null
  pack_color?: string | null
  morning: number
  evening: number
  qty: number
  litres: number
}
export interface PickupGroup {
  agent_id: string | null
  name: string
  items: PickupItem[]
  total_packets: number
  total_litres: number
}

const fmtL = (l: number) => `${Number.isInteger(l) ? l : l.toFixed(1)} L`

export default function PickupList({ group, title }: { group: Pick<PickupGroup, 'items' | 'total_packets' | 'total_litres'>; title?: string }) {
  if (!group.items.length) return <p className="muted small">Nothing to pick up{title ? ` for ${title}` : ''}.</p>
  const evening = group.items.some((i) => i.evening > 0)
  return (
    <div className="pickup">
      {title && <h3>{title}</h3>}
      <table className="pickup-table">
        <thead>
          <tr>
            <th scope="col">Product</th>
            <th scope="col" className="num" aria-label="Morning"><span className="long">Morning</span><span className="short" aria-hidden="true">AM</span></th>
            {evening && <th scope="col" className="num" aria-label="Evening"><span className="long">Evening</span><span className="short" aria-hidden="true">PM</span></th>}
            <th scope="col" className="num">Total</th>
          </tr>
        </thead>
        <tbody>
          {group.items.map((i) => (
            <tr key={i.product_id ?? i.name}>
              <th scope="row">
                <span className="pickup-name">
                  {i.pack_color && <span className="pack-dot" style={{ background: i.pack_color }} aria-hidden="true" />}
                  <span>
                    <strong>{i.name.toLowerCase().startsWith(i.brand.toLowerCase()) ? i.name : `${i.brand} ${i.name}`}</strong>
                    <small>{[i.pack_label && `${i.pack_label} packet`, i.unit].filter(Boolean).join(' · ')}</small>
                  </span>
                </span>
              </th>
              <td className="num">{i.morning || '–'}</td>
              {evening && <td className="num">{i.evening || '–'}</td>}
              <td className="num"><strong>{i.qty}</strong></td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">All packets{group.total_litres > 0 && <small>{fmtL(group.total_litres)} of milk</small>}</th>
            <td className="num">{group.items.reduce((a, i) => a + i.morning, 0)}</td>
            {evening && <td className="num">{group.items.reduce((a, i) => a + i.evening, 0)}</td>}
            <td className="num"><strong>{group.total_packets}</strong></td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
