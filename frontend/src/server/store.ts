/**
 * In-browser data store for the self-contained build.
 *
 * Shared mode: every collection mirrors the artifact's `db` capability (live across devices).
 * Local mode: the same mirror persisted to localStorage (this browser only), used when the
 * shared database isn't available or this viewer can't write to it.
 */
export type Doc = { id: string; [k: string]: any }

export const COLLECTIONS = [
  'users', 'addresses', 'products', 'plans', 'settings', 'areas', 'orders', 'subscriptions', 'deliveries',
  'trips', 'wallet_ledger', 'cod_ledger', 'payments', 'notifications', 'redeliveries', 'route_runs',
] as const
export type Coll = (typeof COLLECTIONS)[number]

type DbRef = {
  collection: (p: string) => {
    doc: (id: string) => { set: (d: Record<string, unknown>) => Promise<void>; delete: () => Promise<void> }
    onSnapshot: (next: (s: { docs: { id: string; exists: boolean; data: () => any }[] }) => void, err?: (e: { code: string }) => void) => () => void
  }
}

const PREFIX = 'mn_'
const LS_KEY = 'moonest_local_v14'
export const PRIVATE_FLAG = 'moonest_private_copy'

class Store {
  mode: 'shared' | 'local' = 'local'
  private data = new Map<Coll, Map<string, Doc>>()
  private db: DbRef | null = null
  private events = new EventTarget()
  private timer: ReturnType<typeof setTimeout> | null = null
  private queues = new Map<string, Promise<void>>()
  readonlyReason = ''
  private unsubs: (() => void)[] = []

  constructor() {
    for (const c of COLLECTIONS) this.data.set(c, new Map())
  }

  /** Boot shared mode: subscribe to every collection and resolve once each has delivered. */
  async connectShared(db: DbRef): Promise<boolean> {
    this.db = db
    this.mode = 'shared'
    let pending = COLLECTIONS.length
    let failed = false
    await new Promise<void>((resolve) => {
      const giveUp = setTimeout(() => {
        failed = true
        resolve()
      }, 12_000)
      for (const c of COLLECTIONS) {
        let first = true
        const off = db.collection(PREFIX + c).onSnapshot(
          (snap) => {
            if (this.mode !== 'shared') return
            const m = new Map<string, Doc>()
            for (const d of snap.docs) if (d.exists) m.set(d.id, { ...d.data(), id: d.id } as Doc)
            this.data.set(c, m)
            this.changed()
            if (first) {
              first = false
              if (--pending === 0) {
                clearTimeout(giveUp)
                resolve()
              }
            }
          },
          () => {
            failed = true
            if (first) {
              first = false
              if (--pending === 0) resolve()
            }
          },
        )
        this.unsubs.push(off)
      }
    })
    return !failed
  }

  /** Can this viewer save to the shared database? One tiny write to a fixed probe document. */
  async canWriteShared(): Promise<boolean> {
    if (!this.db) return false
    try {
      await Promise.race([
        this.db.collection(PREFIX + 'probe').doc('probe').set({ at: Date.now() }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
      ])
      return true
    } catch {
      return false
    }
  }

  /** Switch to a private copy in this browser (keeps what's on screen, stops listening to shared data). */
  fallbackToLocal() {
    if (this.mode === 'local') return
    this.unsubs.forEach((u) => u())
    this.unsubs = []
    this.db = null
    this.mode = 'local'
    let hasLocal = false
    try {
      hasLocal = !!localStorage.getItem(LS_KEY)
    } catch {
      /* ignore */
    }
    if (hasLocal) this.loadLocal()
    else this.persistLocal()
    try {
      localStorage.setItem(PRIVATE_FLAG, '1')
    } catch {
      /* ignore */
    }
    ;(window as unknown as { __moonestMode?: string }).__moonestMode = 'local'
    this.changed()
  }

  loadLocal() {
    this.mode = 'local'
    this.db = null
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || '{}')
      for (const c of COLLECTIONS) this.data.set(c, new Map((raw[c] ?? []).map((d: Doc) => [d.id, d])))
    } catch {
      /* storage unavailable: in-memory only */
    }
  }

  private persistLocal() {
    if (this.mode !== 'local') return
    try {
      const out: Record<string, Doc[]> = {}
      for (const c of COLLECTIONS) out[c] = [...this.data.get(c)!.values()]
      localStorage.setItem(LS_KEY, JSON.stringify(out))
    } catch {
      /* quota or blocked storage: keep going in memory */
    }
  }

  resetLocal() {
    try {
      localStorage.removeItem(LS_KEY)
    } catch {
      /* ignore */
    }
    for (const c of COLLECTIONS) this.data.set(c, new Map())
  }

  private changed() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.events.dispatchEvent(new Event('change')), 120)
  }

  /** Ask every live view to refetch (server mode polls with this; there is no local mirror). */
  pulse() {
    this.events.dispatchEvent(new Event('change'))
  }

  onChange(fn: () => void): () => void {
    this.events.addEventListener('change', fn)
    return () => this.events.removeEventListener('change', fn)
  }

  all(c: Coll): Doc[] {
    return [...this.data.get(c)!.values()].map((d) => structuredClone(d))
  }

  find(c: Coll, pred: (d: Doc) => boolean): Doc[] {
    return this.all(c).filter(pred)
  }

  one(c: Coll, pred: (d: Doc) => boolean): Doc | null {
    for (const d of this.data.get(c)!.values()) if (pred(d)) return structuredClone(d)
    return null
  }

  get(c: Coll, id: string | null | undefined): Doc | null {
    if (!id) return null
    const d = this.data.get(c)!.get(id)
    return d ? structuredClone(d) : null
  }

  /** Full-document write. Mirror updates immediately; shared writes are serialized per document. */
  async put(c: Coll, doc: Doc): Promise<Doc> {
    const clean = JSON.parse(JSON.stringify(doc)) as Doc
    this.data.get(c)!.set(clean.id, clean)
    this.changed()
    this.persistLocal()
    if (this.db) {
      const key = `${c}/${clean.id}`
      const { id, ...body } = clean
      const prev = this.queues.get(key) ?? Promise.resolve()
      const next = prev.catch(() => null).then(() => this.db!.collection(PREFIX + c).doc(id).set(body))
      this.queues.set(key, next)
      try {
        await next
      } catch (e) {
        const code = (e as { code?: string })?.code
        if (code === 'quota_exceeded') throw new Error('The demo database is full. Ask the owner to clear old data.')
        // This viewer can't save to the shared data (e.g. view-only access): carry on with a private copy.
        this.fallbackToLocal()
        this.data.get(c)!.set(clean.id, clean)
        this.persistLocal()
      }
    }
    return clean
  }

  async patch(c: Coll, id: string, upd: Record<string, unknown>): Promise<Doc | null> {
    const cur = this.get(c, id)
    if (!cur) return null
    return this.put(c, { ...cur, ...upd })
  }

  async remove(c: Coll, id: string) {
    this.data.get(c)!.delete(id)
    this.changed()
    this.persistLocal()
    if (this.db) await this.db.collection(PREFIX + c).doc(id).delete()
  }

  isEmpty(): boolean {
    return this.data.get('settings')!.size === 0
  }
}

export const store = new Store()
