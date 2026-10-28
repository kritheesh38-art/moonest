import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { SERVER_MODE } from './api'
import { registerWorker } from './push'
import { boot } from './server/boot'
import { store } from './server/store'
import './server/routes'
import './styles.css'

const root = ReactDOM.createRoot(document.getElementById('root')!)
root.render(
  <div className="boot">
    <img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%232f6b4f'/%3E%3Cpath d='M24 14h16v6l4 8v22a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4V28l4-8z' fill='%23fffaf0'/%3E%3Crect x='24' y='34' width='16' height='10' rx='2' fill='%23f2c14e'/%3E%3C/svg%3E" width={56} height={56} alt="" />
    <p>Loading MooNest…</p>
  </div>,
)
/** Server mode: refresh open screens every few seconds so tracking, routes and orders stay live. */
function startServerSync() {
  registerWorker() // receives push notifications, even with the app closed
  setInterval(() => document.visibilityState === 'visible' && store.pulse(), 5000)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && store.pulse())
  return Promise.resolve('server' as const)
}

;(SERVER_MODE ? startServerSync() : boot()).then((mode) => {
  ;(window as unknown as { __moonestMode: string }).__moonestMode = mode
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
