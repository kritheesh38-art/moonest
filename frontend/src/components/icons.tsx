/** Line icons (1.75 stroke, 24 grid) matching the MooNest look. */
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }
const base = (size = 20): SVGProps<SVGSVGElement> => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
})
const mk = (d: JSX.Element) => ({ size, ...rest }: P) => <svg {...base(size)} {...rest}>{d}</svg>

export const IconBottle = mk(<><path d="M9 2h6v3l2 4v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9l2-4z" /><path d="M7 13h10" /></>)
export const IconHome = mk(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" /></>)
export const IconRepeat = mk(<><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>)
export const IconPin = mk(<><path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0z" /><circle cx="12" cy="10" r="3" /></>)
export const IconWallet = mk(<><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 10h18" /><path d="M16 15h2" /><path d="M6 6V4.5A1.5 1.5 0 0 1 7.5 3h10" /></>)
export const IconUser = mk(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>)
export const IconBell = mk(<><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>)
export const IconBag = mk(<><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" /><path d="M3 6h18" /><path d="M16 10a4 4 0 0 1-8 0" /></>)
export const IconClock = mk(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>)
export const IconShield = mk(<><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></>)
export const IconLeaf = mk(<><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10z" /><path d="M2 21c0-3 1.9-5.4 5-6" /></>)
export const IconArrowRight = mk(<><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>)
export const IconArrowLeft = mk(<><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>)
export const IconReceipt = mk(<><path d="M4 2v20l3-2 3 2 2-2 2 2 3-2 3 2V2l-3 2-3-2-2 2-2-2-3 2z" /><path d="M8 9h8M8 13h6" /></>)
export const IconCheck = mk(<path d="M20 6 9 17l-5-5" />)
export const IconX = mk(<><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>)
export const IconLock = mk(<><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>)
export const IconCard = mk(<><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /><path d="M6 15h4" /></>)
export const IconBank = mk(<><path d="M3 21h18" /><path d="M5 21V10M9 21V10M15 21V10M19 21V10" /><path d="M2 10 12 3l10 7z" /></>)
export const IconPhone = mk(<><rect x="6" y="2" width="12" height="20" rx="2" /><path d="M11 18h2" /></>)
export const IconTruck = mk(<><path d="M14 18V6H2v12h2" /><path d="M14 9h4l4 4v5h-2" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /><path d="M9 18h6" /></>)
export const IconCalendar = mk(<><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>)
export const IconPause = mk(<><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>)
export const IconPlus = mk(<><path d="M12 5v14" /><path d="M5 12h14" /></>)
export const IconLogout = mk(<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>)
export const IconChevron = mk(<path d="m9 18 6-6-6-6" />)

/** The MooNest mark: green rounded tile with a bottle. */
export function Logo({ size = 40, wordmark = true, light = false }: { size?: number; wordmark?: boolean; light?: boolean }) {
  return (
    <span className={`logo${light ? ' logo-light' : ''}`}>
      <img className="logo-mark" src="img/logo-mark.png" alt="" width={size} height={size} />
      {wordmark && <span className="logo-word">MooNest</span>}
    </span>
  )
}
export const IconSunrise = mk(<><path d="M12 2v6" /><path d="m4.9 10.9 1.4 1.4" /><path d="M2 18h2M20 18h2" /><path d="m19.1 10.9-1.4 1.4" /><path d="M22 22H2" /><path d="M16 18a4 4 0 0 0-8 0" /><path d="m8 6 4-4 4 4" /></>)
export const IconSunset = mk(<><path d="M12 10V2" /><path d="m4.9 10.9 1.4 1.4" /><path d="M2 18h2M20 18h2" /><path d="m19.1 10.9-1.4 1.4" /><path d="M22 22H2" /><path d="M16 18a4 4 0 0 0-8 0" /><path d="m16 6-4 4-4-4" /></>)
export const IconCash = mk(<><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6 12h.01M18 12h.01" /></>)
export const IconCamera = mk(<><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" /><circle cx="12" cy="13" r="3.5" /></>)
export const IconNavigate = mk(<path d="m3 11 19-9-9 19-2-8z" />)
export const IconPalm = mk(<><path d="M13 8c0-2.8-2.2-5-5-5-1.8 0-3.4.9-4.3 2.4" /><path d="M13 8c0-2.8 2.2-5 5-5 1.8 0 3.4.9 4.3 2.4" /><path d="M13 8c-3 0-6 1.5-7 5" /><path d="M13 8c3 0 6 1.5 7 5" /><path d="M13 8v13" /><path d="M8 21h10" /></>)
