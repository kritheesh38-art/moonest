export type Role = 'customer' | 'agent' | 'admin'
export type Slot = 'morning' | 'evening'

export interface User {
  id: string
  name: string
  phone?: string
  email?: string
  roles: Role[]
  role: Role
  missed_pref?: 'wallet_credit' | 'redeliver'
  pincodes?: string[]
  wallet_paise?: number
  cod_due_paise?: number
  needs_phone?: boolean
}

export interface AppConfig {
  city: string
  slots: { code: Slot; label: string; time: string }[]
  skip_cutoff_hour: number
  max_pause_days: number
  delivery_fee_paise: number
  free_delivery_above_paise: number
  next_cycle_date: string
  server_time: string
  payments_mode: 'live' | 'demo' | 'disabled'
  razorpay_key_id: string | null
  demo_mode: boolean
  location_interval_seconds: number
  /** OTP sign-in works (SMS configured, or demo mode shows the code) */
  otp_available?: boolean
  /** the server can turn a GPS position into an address */
  geocoding?: boolean
  place_search?: 'google' | 'ola' | 'osm' | null
  data_mode?: string
}

export interface Product {
  id: string
  name: string
  brand: string
  supplier: string
  category: string
  unit: string
  price_paise: number
  mrp_paise?: number | null
  description: string
  image: string
  tags: string[]
  active: boolean
  subscribable: boolean
  /** Products sharing a group are one item with several packet colours (fat variants). */
  group?: string
  pack_label?: string
  pack_color?: string
  fat?: string
  sort?: number
}

export interface Plan {
  id: string
  code: 'daily' | 'alternate' | 'custom'
  name: string
  description: string
  discount_pct: number
  perks: string[]
  active: boolean
}

export interface Address {
  id: string
  label: string
  line1: string
  line2: string
  landmark: string
  pincode: string
  area?: string
  lat?: number
  lng?: number
  contact_phone?: string | null
  is_default: boolean
}

export interface OrderItem {
  product_id: string
  name: string
  unit: string
  qty: number
  price_paise: number
  line_total_paise?: number
  image?: string
}

export interface Order {
  id: string
  number: string
  items: OrderItem[]
  subtotal_paise: number
  delivery_fee_paise: number
  total_paise: number
  address: Address
  slot: Slot
  delivery_date: string
  payment_method: 'razorpay' | 'wallet' | 'cod'
  payment_status: string
  status: string
  created_at: string
  can_cancel?: boolean
  rescheduled?: boolean
  failure_reason?: string
  delivery?: { status: string; photo_url?: string; delivered_at?: string; failure_reason?: string }
}

export interface PaymentIntent {
  payment_id: string
  razorpay_order_id: string
  amount_paise: number
  demo: boolean
  customer_id?: string
  recurring?: boolean
}

export interface Subscription {
  id: string
  product_id: string
  product: Product
  plan: Plan
  plan_code: Plan['code']
  custom_days: number[]
  quantity: number
  slot: Slot
  slot_label: string
  start_date: string
  address: Address | null
  pending_address: Address | null
  pending_effective_date?: string
  payment_method: 'autopay' | 'wallet' | 'cod'
  status: 'active' | 'paused' | 'cancelled' | 'pending_mandate'
  display_status: string
  skips: string[]
  pauses: { id: string; start_date: string; end_date: string }[]
  unit_price_paise: number
  per_delivery_paise: number
  est_monthly_paise: number
  upcoming: { date: string; state: 'scheduled' | 'skipped' | 'paused' }[]
  next_editable_date: string
  cutoff_hour: number
}

export interface LedgerEntry {
  id: string
  type: 'credit' | 'debit' | 'due' | 'collected' | 'waived'
  amount_paise: number
  reason?: string
  note?: string
  ref?: string
  balance_after_paise?: number
  created_at: string
}

export interface Notification {
  id: string
  title: string
  body: string
  kind: string
  ref: string
  image_url: string
  read: boolean
  created_at: string
}

export interface Loc {
  lat: number
  lng: number
  ts: string
}

export interface Tracking {
  delivery_id: string
  status: string
  slot: Slot
  date: string
  destination: { lat?: number; lng?: number }
  trip_status: 'active' | 'ended' | 'not_started'
  agent: { name: string } | null
  location: Loc | null
  signal: 'live' | 'lost' | 'none'
  age_seconds: number | null
  stops_before_you: number
  eta_minutes: number | null
  photo_url?: string
  delivered_at?: string
  items?: OrderItem[]
}

export interface Stop {
  id: string
  kind: 'order' | 'subscription' | 'redelivery'
  ref_id: string
  user_id: string
  customer_name: string
  customer_phone: string
  address: Address
  slot: Slot
  sequence: number
  items: OrderItem[]
  amount_paise: number
  payment_method: string
  payment_status: string
  status: 'pending' | 'delivered' | 'skipped' | 'failed'
  photo_url?: string
  failure_reason?: string
  cod_collected_paise: number
  cod_due_paise: number
  agent_id?: string | null
  date: string
}

export interface Trip {
  id: string
  agent_id: string
  date: string
  slot: Slot
  status: 'active' | 'ended'
  started_at: string
  ended_at?: string
  last_location: Loc | null
  summary?: Tally
  handoff_note?: string
  cash_handed_over_paise?: number
  name?: string
  phone?: string
  pending?: number
}

export interface Tally {
  cash_collected_paise: number
  pending: number
  delivered: number
  skipped: number
  failed: number
  total: number
}
