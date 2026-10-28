import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, getToken, setToken } from './api'
import { store } from './server/store'
import type { AppConfig, Product, User } from './types'

interface AuthCtx {
  user: User | null
  loading: boolean
  config: AppConfig | null
  login: (token: string, user: User) => void
  logout: () => void
  refresh: () => Promise<void>
  refreshConfig: () => Promise<void>
}

const Auth = createContext<AuthCtx>(null!)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [config, setConfig] = useState<AppConfig | null>(null)

  const refresh = useCallback(async () => {
    if (!getToken()) {
      setUser(null)
      return
    }
    try {
      setUser(await api<User>('/api/auth/me'))
    } catch {
      setUser(null)
    }
  }, [])

  useEffect(() => {
    Promise.all([refresh(), api<AppConfig>('/api/config').then(setConfig).catch(() => null)]).finally(() => setLoading(false))
    const onLogout = () => setUser(null)
    window.addEventListener('moonest:logout', onLogout)
    const off = store.onChange(() => {
      if (getToken()) api<User>('/api/auth/me').then(setUser).catch(() => null)
      api<AppConfig>('/api/config').then(setConfig).catch(() => null) // e.g. an admin switched demo mode
    })
    return () => {
      window.removeEventListener('moonest:logout', onLogout)
      off()
    }
  }, [refresh])

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      loading,
      config,
      login: (token, u) => {
        setToken(token)
        setUser(u)
        refresh()
      },
      logout: () => {
        setToken(null)
        setUser(null)
        window.dispatchEvent(new Event('moonest:logout'))
      },
      refresh,
      refreshConfig: () => api<AppConfig>('/api/config').then(setConfig).catch(() => undefined),
    }),
    [user, loading, config, refresh],
  )
  return <Auth.Provider value={value}>{children}</Auth.Provider>
}

export const useAuth = () => useContext(Auth)

// ---------------- cart ----------------
export interface CartLine {
  product: Product
  qty: number
}

interface CartCtx {
  lines: CartLine[]
  add: (p: Product, qty?: number) => void
  setQty: (id: string, qty: number) => void
  clear: () => void
  count: number
  subtotal: number
}

const Cart = createContext<CartCtx>(null!)
const CART_KEY = 'moonest_cart'

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(CART_KEY) || '[]')
    } catch {
      return []
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(lines))
    } catch {
      /* ignore */
    }
  }, [lines])
  // Keep prices and availability current: the saved cart holds a copy of each product
  useEffect(() => {
    const sync = () =>
      api<Product[]>('/api/products')
        .then((ps) => {
          const live = new Map(ps.map((p) => [p.id, p]))
          setLines((ls) => {
            const next = ls.filter((l) => live.has(l.product.id)).map((l) => ({ ...l, product: live.get(l.product.id)! }))
            return JSON.stringify(next) === JSON.stringify(ls) ? ls : next
          })
        })
        .catch(() => null)
    sync()
    const off = store.onChange(sync)
    const clear = () => setLines([]) // a new person signing in on this device starts with an empty cart
    window.addEventListener('moonest:logout', clear)
    return () => {
      off()
      window.removeEventListener('moonest:logout', clear)
    }
  }, [])

  const value = useMemo<CartCtx>(
    () => ({
      lines,
      add: (p, qty = 1) =>
        setLines((ls) => {
          const ex = ls.find((l) => l.product.id === p.id)
          if (ex) return ls.map((l) => (l.product.id === p.id ? { ...l, qty: Math.min(20, l.qty + qty) } : l))
          return [...ls, { product: p, qty }]
        }),
      setQty: (id, qty) =>
        setLines((ls) => (qty <= 0 ? ls.filter((l) => l.product.id !== id) : ls.map((l) => (l.product.id === id ? { ...l, qty: Math.min(20, qty) } : l)))),
      clear: () => setLines([]),
      count: lines.reduce((s, l) => s + l.qty, 0),
      subtotal: lines.reduce((s, l) => s + l.qty * l.product.price_paise, 0),
    }),
    [lines],
  )
  return <Cart.Provider value={value}>{children}</Cart.Provider>
}

export const useCart = () => useContext(Cart)

// ---------------- toasts ----------------
type Toast = { id: number; text: string; tone: 'ok' | 'bad' | 'info' }
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const push = useCallback((text: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, text, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)

// ---------------- data hook ----------------
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!!path)
  const load = useCallback(async () => {
    if (!path) return
    setLoading(true)
    try {
      setData(await api<T>(path))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps])
  useEffect(() => {
    load()
  }, [load])
  useEffect(() => {
    if (!path) return
    return store.onChange(async () => {
      try {
        setData(await api<T>(path))
      } catch {
        /* keep last good data */
      }
    })
  }, [path])
  return { data, error, loading, reload: load, setData }
}
