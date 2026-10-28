import { useEffect, useRef, useState } from 'react'
import { Link, Route, Routes } from 'react-router-dom'
import { api } from '../../api'
import { pushActive, syncPush } from '../../push'
import { IconBag, IconBell, IconHome, IconPin, IconRepeat, IconUser, IconWallet } from '../../components/icons'
import { BottomNav, PageTransition, TopBar } from '../../components/ui'
import { useAuth, useCart } from '../../state'
import type { Notification } from '../../types'
import Account from './Account'
import Checkout from './Checkout'
import Home from './Home'
import Notifications from './Notifications'
import { OrderDetail, Orders } from './Orders'
import Plans from './Plans'
import Shop from './Shop'
import Subscribe from './Subscribe'
import { SubscriptionDetail, Subscriptions } from './Subscriptions'
import Track from './Track'
import Wallet from './Wallet'

/** Polls notifications; shows a browser notification for new ones when permission is granted. */
function useNotificationFeed() {
  const [unread, setUnread] = useState(0)
  const seen = useRef<Set<string> | null>(null)
  useEffect(() => {
    syncPush() // this phone's alerts go to whoever is signed in now
  }, [])
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try {
        const list = await api<Notification[]>('/api/notifications')
        if (!alive) return
        setUnread(list.filter((n) => !n.read).length)
        if (seen.current) {
          for (const n of list) {
            if (!seen.current.has(n.id) && !n.read) {
              try {
                if ('Notification' in window && Notification.permission === 'granted' && !pushActive()) new Notification(n.title, { body: n.body, tag: n.id })
              } catch {
                /* not allowed in this frame */
              }
            }
          }
        }
        seen.current = new Set(list.map((n) => n.id))
      } catch {
        /* offline */
      }
    }
    tick()
    const t = setInterval(tick, 5_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])
  return { unread, clear: () => setUnread(0) }
}

export default function CustomerApp() {
  const { count } = useCart()
  const { user } = useAuth()
  const feed = useNotificationFeed()
  return (
    <div className="app">
      <TopBar
        title="MooNest"
        right={
          <>
            {count > 0 && (
              <Link to="/cart" className="icon-btn" aria-label={`Cart, ${count} items`}>
                <IconBag size={22} />
                <span className="dot">{count}</span>
              </Link>
            )}
            <Link to="/notifications" className="icon-btn" aria-label="Notifications">
              <IconBell size={22} />
              {feed.unread > 0 && <span className="dot">{feed.unread}</span>}
            </Link>
          </>
        }
      />
      {user?.needs_phone && (
        <Link to="/account" className="notice">
          Add your 10-digit mobile number so milk agents can reach you →
        </Link>
      )}
      <main className="content">
        <PageTransition>
        <Routes>
          <Route index element={<Home />} />
          <Route path="shop" element={<Shop />} />
          <Route path="cart" element={<Checkout />} />
          <Route path="orders" element={<Orders />} />
          <Route path="orders/:id" element={<OrderDetail />} />
          <Route path="plans" element={<Plans />} />
          <Route path="subscribe" element={<Subscribe />} />
          <Route path="subscriptions" element={<Subscriptions />} />
          <Route path="subscriptions/:id" element={<SubscriptionDetail />} />
          <Route path="track" element={<Track />} />
          <Route path="wallet" element={<Wallet />} />
          <Route path="account" element={<Account />} />
          <Route path="notifications" element={<Notifications onRead={feed.clear} />} />
          <Route path="*" element={<Home />} />
        </Routes>
        </PageTransition>
      </main>
      <BottomNav
        items={[
          { to: '/', label: 'Shop', icon: <IconHome size={22} /> },
          { to: '/plans', label: 'Plans', icon: <IconRepeat size={22} /> },
          { to: '/track', label: 'Track', icon: <IconPin size={22} /> },
          { to: '/wallet', label: 'Wallet', icon: <IconWallet size={22} /> },
          { to: '/account', label: 'Me', icon: <IconUser size={22} /> },
        ]}
      />
    </div>
  )
}
