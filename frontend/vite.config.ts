import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev, /api (REST + WebSocket) is proxied to the FastAPI backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    host: true,
    proxy: {
      '/api': { target: process.env.VITE_BACKEND_URL || 'http://localhost:8001', ws: true, changeOrigin: true },
    },
  },
})
