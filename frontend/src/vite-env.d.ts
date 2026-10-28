interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string
  /** "server" talks to the FastAPI backend; anything else runs the in-browser backend */
  readonly VITE_API_MODE?: string
  readonly VITE_API_URL?: string
  readonly VITE_SHARED_APP_URL?: string
  /** street map tiles (server build); default CARTO Voyager */
  readonly VITE_MAP_TILES?: string
  /** driving-route service (OSRM-compatible); empty = straight line */
  readonly VITE_ROUTER_URL?: string
}
interface ImportMeta { readonly env: ImportMetaEnv }
