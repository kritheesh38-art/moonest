import catalogue from './catalogue.json'
import { DEFAULT_SETTINGS, nowIso } from './logic'
import { hashPassword } from './routes'
import { Coll, Doc, PRIVATE_FLAG, store } from './store'

/**
 * Catalogue, shared with the FastAPI backend (backend/app/data/catalogue.json must stay identical;
 * a backend test checks this). Pouch milk is colour-coded by fat content: each colour is its own
 * product (own price and stock) and products sharing a `group` show as one item with a colour picker.
 * Prices are MRPs in paise, editable in Admin.
 */
type Item = { id: string; group?: string; name: string; brand: string; supplier: string; unit: string; price_paise: number; mrp_paise: number | null; category: string; tags: string[]; description: string; image: string; subscribable: boolean; pack_label?: string; pack_color?: string; fat?: string }
export const CATALOGUE: Item[] = catalogue

/** Demo password "pass1234" (salted SHA-256), shown on the sign-in screen. */
export const DEMO_PW = { salt: 'moonestdemo2026', password_hash: '' }
const ADMIN_PW = { salt: 'mn-admin-2026', password_hash: 'febca8aa25b9d55df88e5af1673934f0932436c707518a7f3ce2c695fc691c38' }

/** Reference data. Ids are fixed so seeding from several devices at once never duplicates. */
export function seedDocs(): Record<string, Doc[]> {
  const t = nowIso()
  return {
    settings: [{ ...DEFAULT_SETTINGS }],
    plans: [
      { id: 'plan-daily', code: 'daily', name: 'Daily', description: 'Fresh milk every single day.', discount_pct: 5, perks: ['5% off every delivery', 'Skip any day before 10 PM', 'Vacation pause up to 30 days'], sort: 1, active: true },
      { id: 'plan-alternate', code: 'alternate', name: 'Alternate Day', description: 'Delivered every other day.', discount_pct: 3, perks: ['3% off every delivery', 'Great for smaller households', 'Skip or pause anytime'], sort: 2, active: true },
      { id: 'plan-custom', code: 'custom', name: 'Custom Days', description: 'Choose the weekdays that suit you.', discount_pct: 0, perks: ['Pick any weekdays', 'Change days anytime', 'No lock-in'], sort: 3, active: true },
    ],
    areas: [
      ['560034', 'Koramangala', 12.9352, 77.6245], ['560095', 'Koramangala 6th Block', 12.939, 77.619], ['560102', 'HSR Layout', 12.9116, 77.6474],
      ['560038', 'Indiranagar', 12.9719, 77.6412], ['560068', 'Bommanahalli', 12.9081, 77.6233], ['560076', 'BTM Layout', 12.9166, 77.6101],
    ].map(([pincode, name, lat, lng]) => ({ id: pincode as string, pincode, name, lat, lng, active: true })),
    products: CATALOGUE.map((p, i) => ({ ...p, active: true, sort: i, created_at: t })),
    users: [
      // Admins: username + password only. Only the salted hash is stored here, never the password.
      { id: 'u-admin-ritissh', username: 'ritissh', name: 'Ritissh', ...ADMIN_PW, roles: ['admin'], wallet_paise: 0, created_at: t },
      { id: 'u-admin-kritheesh', username: 'kritheesh', name: 'Kritheesh', ...ADMIN_PW, roles: ['admin'], wallet_paise: 0, created_at: t },
      { id: 'u-admin-subhasree', username: 'subhasree', name: 'Subhasree', ...ADMIN_PW, roles: ['admin'], wallet_paise: 0, created_at: t },
      { id: 'u-agent-ravi', name: 'Ravi Kumar', phone: '9000000001', email: 'agent@moonest.in', ...DEMO_PW, roles: ['agent'], pincodes: ['560034', '560095', '560068', '560076'], active: true, wallet_paise: 0, created_at: t },
      { id: 'u-demo-customer', name: 'Aditi Rao', phone: '9811122233', email: 'customer@moonest.in', ...DEMO_PW, roles: ['customer'], wallet_paise: 50000, missed_pref: 'wallet_credit', created_at: t },
      { id: 'u-agent-suresh', name: 'Suresh N', phone: '9000000002', roles: ['agent'], pincodes: ['560102', '560038'], active: true, wallet_paise: 0, created_at: t },
    ],
  }
}

async function seed() {
  if (!DEMO_PW.password_hash) DEMO_PW.password_hash = await hashPassword('pass1234', DEMO_PW.salt)
  for (const [c, docs] of Object.entries(seedDocs())) for (const d of docs) if (!store.get(c as Coll, d.id)) await store.put(c as Coll, d)
}

/**
 * Every start: make sure the admin and demo accounts exist. A private copy (a view-only visitor)
 * is built from whatever shared data loaded, which may not include accounts, so without this the
 * admins couldn't sign in there. Existing accounts are left alone, except that admin accounts get the
 * current admin password.
 */
async function ensureAccounts() {
  if (!DEMO_PW.password_hash) DEMO_PW.password_hash = await hashPassword('pass1234', DEMO_PW.salt)
  for (const u of seedDocs().users) {
    const cur = store.get('users', u.id)
    // admin passwords are set here, so a changed admin password reaches every copy
    if (cur && u.roles.includes('admin') && (cur.password_hash !== u.password_hash || cur.salt !== u.salt)) {
      try {
        await store.put('users', { ...cur, salt: u.salt, password_hash: u.password_hash, roles: [...new Set([...(cur.roles ?? []), 'admin'])] })
      } catch {
        /* view-only shared data: the private copy gets it on its own start */
      }
      continue
    }
    if (cur) continue
    try {
      await store.put('users', u)
    } catch {
      /* shared data this viewer can't write: the private copy path below covers them */
    }
  }
}

type ClaudeWin = { claude?: { use: (n: string) => Promise<any> } }

/** Shared live data when this view can write the artifact's database; otherwise this browser only. */
export async function boot(): Promise<'shared' | 'local'> {
  const c = (window as unknown as ClaudeWin).claude
  let privateCopy = false
  try {
    privateCopy = localStorage.getItem(PRIVATE_FLAG) === '1'
  } catch {
    /* ignore */
  }
  if (c?.use && !privateCopy) {
    const [db, user] = await Promise.all([c.use('db').catch(() => null), c.use('user').catch(() => null)])
    let canWrite: boolean | null = null
    try {
      canWrite = (await user?.can?.('data.write')) ?? null
    } catch {
      canWrite = null
    }
    if (db && canWrite !== false && (await store.connectShared(db))) {
      if (await store.canWriteShared()) {
        if (store.isEmpty()) await seed()
        await ensureAccounts()
        if (store.mode === 'shared') return 'shared'
      }
      // Signed in but view-only (e.g. outside the organisation): private copy of the shared catalogue
      store.fallbackToLocal()
      if (store.isEmpty()) await seed()
      await ensureAccounts()
      return 'local'
    }
  }
  store.loadLocal()
  if (store.isEmpty()) await seed()
  await ensureAccounts()
  return 'local'
}

export async function resetLocalDemo() {
  store.resetLocal()
  await seed()
}
