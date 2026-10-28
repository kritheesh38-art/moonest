/* MooNest service worker: shows push notifications, even when the app is closed, and opens the
   right page when one is tapped. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))

self.addEventListener('push', (e) => {
  let d = {}
  try {
    d = e.data ? e.data.json() : {}
  } catch {
    d = { body: e.data && e.data.text() }
  }
  e.waitUntil(
    self.registration.showNotification(d.title || 'MooNest', {
      body: d.body || '',
      tag: d.tag || 'moonest',
      renotify: true,
      icon: '/icon-192.png',
      badge: '/favicon-96.png',
      image: d.image || undefined,
      data: { url: d.url || '/#/notifications', skip_token: d.skip_token },
      actions: (d.actions || []).slice(0, 2),
      requireInteraction: !!d.skip_token,
      vibrate: [120, 60, 120],
    }),
  )
})

/** "Skip tomorrow" on the evening reminder: skips right from the notification, no need to open the app. */
async function skipFromReminder(token) {
  let title = 'Couldn\'t skip tomorrow'
  let body = 'Open MooNest to skip it.'
  try {
    const r = await fetch('/api/push/skip', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
    const j = await r.json().catch(() => ({}))
    if (r.ok) (title = 'Tomorrow skipped'), (body = j.message || 'No delivery and no charge tomorrow.')
    else body = j.detail || body
  } catch {
    body = 'No internet connection. Open MooNest to skip it.'
  }
  await self.registration.showNotification(title, { body, tag: 'skip-result', icon: '/icon-192.png', badge: '/favicon-96.png', data: { url: '/#/subscriptions' } })
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  if (e.action === 'skip' && e.notification.data && e.notification.data.skip_token) {
    e.waitUntil(skipFromReminder(e.notification.data.skip_token))
    return
  }
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const open = wins.find((w) => w.url.startsWith(self.location.origin))
      if (open) return open.navigate(url).then((w) => (w || open).focus()).catch(() => open.focus())
      return self.clients.openWindow(url)
    }),
  )
})
