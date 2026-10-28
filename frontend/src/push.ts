/** Phone / browser push notifications (server build only): the service worker shows them even
 *  when the app is closed. On iPhone they work once MooNest is added to the home screen. */
import { api, SERVER_MODE } from './api'

const FLAG = 'moonest:push'
export type PushState = 'on' | 'off' | 'blocked' | 'needs-install' | 'unsupported'

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const installed = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true

function supported() {
  return SERVER_MODE && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

/** Registered on start-up so the worker is ready to receive pushes. */
export function registerWorker() {
  if (!SERVER_MODE || !('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('/sw.js').catch(() => undefined)
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIOS() && SERVER_MODE && !installed() ? 'needs-install' : 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    return sub && Notification.permission === 'granted' ? 'on' : 'off'
  } catch {
    return 'off'
  }
}

/** True when push alerts are on, so the page needn't show its own pop-ups as well. */
export const pushActive = () => {
  try {
    return localStorage.getItem(FLAG) === 'on' && Notification.permission === 'granted'
  } catch {
    return false
  }
}

const toBytes = (b64: string) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

export async function enablePush(): Promise<PushState> {
  if (!supported()) return pushState()
  if ((await Notification.requestPermission()) !== 'granted') return Notification.permission === 'denied' ? 'blocked' : 'off'
  const { enabled, public_key } = await api<{ enabled: boolean; public_key: string | null }>('/api/push/key')
  if (!enabled || !public_key) throw new Error('Notifications are switched off on the server')
  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  const key = toBytes(public_key)
  const current = sub?.options.applicationServerKey
  if (sub && current && new Uint8Array(current).join() !== key.join()) {
    await sub.unsubscribe() // the server's key changed: subscribe again
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  const json = sub.toJSON()
  await api('/api/push/subscribe', { body: { endpoint: json.endpoint, keys: json.keys, agent: navigator.userAgent.slice(0, 200) } })
  try {
    localStorage.setItem(FLAG, 'on')
  } catch {
    /* fine */
  }
  return 'on'
}

export async function disablePush(): Promise<PushState> {
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    const sub = await reg?.pushManager.getSubscription()
    if (sub) {
      await api('/api/push/unsubscribe', { body: { endpoint: sub.endpoint } }).catch(() => undefined)
      await sub.unsubscribe()
    }
    localStorage.removeItem(FLAG)
  } catch {
    /* fine */
  }
  return pushState()
}

/** Re-sends this device's subscription after sign-in (another account may have used this phone). */
export async function syncPush() {
  if ((await pushState()) !== 'on') return
  try {
    const sub = await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription()
    const json = sub?.toJSON()
    if (json?.endpoint) await api('/api/push/subscribe', { body: { endpoint: json.endpoint, keys: json.keys, agent: navigator.userAgent.slice(0, 200) } })
  } catch {
    /* next time */
  }
}
