/**
 * API client, two modes:
 * - in-browser (default; the self-contained published build): every call is answered by
 *   `server/routes.ts`, backed by the artifact's shared database or this browser's storage.
 * - server (`VITE_API_MODE=server`): real HTTP calls to the FastAPI backend with a bearer token.
 *   `VITE_API_URL` sets its origin; leave it empty when the backend serves this app (or in dev, via the proxy).
 * Both sides expose the same endpoints, request bodies and responses.
 */
import { HttpError } from './server/logic'
import { dispatch, getSession, setSession } from './server/routes'

export const SERVER_MODE = import.meta.env.VITE_API_MODE === 'server'
/** The shared app everyone uses (server build). The claude.ai link points private copies there. */
export const SHARED_APP_URL = import.meta.env.VITE_SHARED_APP_URL || 'https://moonest-o1hh.onrender.com'
const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')
const TOKEN_KEY = 'moonest_token'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

let memToken: string | null = null
export function getToken(): string | null {
  if (!SERVER_MODE) return getSession() ? 'local-session' : null
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memToken
  } catch {
    return memToken
  }
}
export function setToken(t: string | null) {
  if (!SERVER_MODE) {
    if (!t) setSession(null)
    return
  }
  memToken = t
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* token kept in memory for this tab */
  }
}

function signedOut() {
  setToken(null)
  window.dispatchEvent(new Event('moonest:logout'))
}

/** FastAPI errors: `{detail: "message"}` or, for validation, `{detail: [{msg, loc}]}`. */
function errorMessage(status: number, body: unknown): string {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail[0]?.msg) {
    const field = String(detail[0].loc?.[detail[0].loc.length - 1] ?? '')
    const msg = String(detail[0].msg).replace(/^Value error, /, '')
    return field === 'phone' ? 'Enter a valid 10-digit mobile number' : field ? `${field.replace(/_/g, ' ')}: ${msg}` : msg
  }
  return status >= 500 ? 'Something went wrong on our side. Please try again.' : 'Request failed'
}

async function http<T>(method: string, path: string, body: unknown, form?: FormData): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (!form && body !== undefined) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(API_URL + path, { method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) })
  } catch {
    throw new ApiError(0, "Can't reach MooNest right now. Check your connection and try again.")
  }
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401 && token) signedOut()
    throw new ApiError(res.status, errorMessage(res.status, data))
  }
  return data as T
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.form ? 'POST' : 'GET')
  if (SERVER_MODE) return http<T>(method, path, opts.body, opts.form)
  try {
    return (await dispatch(method, path, opts.body, opts.form)) as T
  } catch (e) {
    if (e instanceof HttpError) {
      if (e.status === 401 && getSession()) signedOut()
      throw new ApiError(e.status, e.message)
    }
    console.error(e)
    throw new ApiError(500, (e as Error).message || 'Something went wrong. Please try again.')
  }
}

/** Live connection to a server path (live tracking). The session token goes in the first message,
 *  not the address, so it never appears in server logs. */
export function openLiveSocket(path: string) {
  const base = API_URL || window.location.origin
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}${path}`)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ token: getToken() ?? '' })))
  return ws
}

/** Photo links: uploads live on the API server; data URLs and bundled images are used as they are. */
export function assetUrl(path?: string | null): string | undefined {
  if (!path) return undefined
  return SERVER_MODE && path.startsWith('/api/') ? API_URL + path : path
}
