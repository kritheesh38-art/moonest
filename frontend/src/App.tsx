import { ReactNode } from 'react'
import { HashRouter, MemoryRouter, Navigate, Route, Routes } from 'react-router-dom'
import { SERVER_MODE } from './api'
import { PaymentProvider } from './components/payments'
import { PrivateCopyBanner, Spinner } from './components/ui'
import AdminApp from './pages/admin/AdminApp'
import AgentApp from './pages/agent/AgentApp'
import CustomerApp from './pages/customer/CustomerApp'
import LiveDemo from './pages/LiveDemo'
import Login, { Landing, Signup } from './pages/Login'
import { AuthProvider, CartProvider, ToastProvider, useAuth } from './state'
import type { Role } from './types'

/** Server build: real browser history, so the phone's Back button moves within the app. The claude.ai
 *  page runs inside a frame, where in-memory history is the safe choice. */
const Router = SERVER_MODE ? HashRouter : MemoryRouter

function Protected({ role, children }: { role: Role; children: ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <Spinner />
  if (!user) return <Navigate to={role === 'admin' ? '/admin/login' : role === 'agent' ? '/login?role=agent' : '/welcome'} replace />
  if (user.role !== role) return <Navigate to={user.role === 'customer' ? '/' : `/${user.role}`} replace />
  return <>{children}</>
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <PaymentProvider>
          <CartProvider>
            <Router>
              <PrivateCopyBanner />
              <Routes>
                <Route path="/welcome" element={<Landing />} />
                <Route path="/live-demo" element={<LiveDemo />} />
                <Route path="/signup" element={<Signup />} />
                <Route path="/login" element={<Login key="login" />} />
                <Route path="/admin/login" element={<Login key="admin-login" />} />
                <Route path="/agent/*" element={<Protected role="agent"><AgentApp /></Protected>} />
                <Route path="/admin/*" element={<Protected role="admin"><AdminApp /></Protected>} />
                <Route path="/*" element={<Protected role="customer"><CustomerApp /></Protected>} />
              </Routes>
            </Router>
          </CartProvider>
        </PaymentProvider>
      </AuthProvider>
    </ToastProvider>
  )
}
