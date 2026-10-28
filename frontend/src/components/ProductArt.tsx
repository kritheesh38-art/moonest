import { useId, useState } from 'react'
import type { Product } from '../types'

/**
 * Studio product renders (published pages can't load outside photos). Built like a product
 * shot: marble or wood surface, window light with a soft-edged shadow, cylindrical shading,
 * glass speculars, contact and cast shadows, depth-of-field and film grain.
 */
type ArtProduct = Pick<Product, 'name' | 'brand' | 'category' | 'unit' | 'tags'> & { image?: string }

/** Real product photo; falls back to the studio render if the photo is missing or fails to load. */
export default function ProductArt({ p, className }: { p: ArtProduct; className?: string }) {
  const [broken, setBroken] = useState(false)
  if (p.image && !broken)
    return <img className={`product-art product-photo ${className ?? ''}`} src={p.image} alt={`${p.brand} ${p.name}, ${p.unit}`} loading="lazy" decoding="async" onError={() => setBroken(true)} />
  return <RenderedArt p={p} className={className} />
}

function RenderedArt({ p, className }: { p: ArtProduct; className?: string }) {
  const uid = useId().replace(/:/g, '')
  const id = (s: string) => `${s}-${uid}`
  const url = (s: string) => `url(#${id(s)})`
  const n = p.name.toLowerCase()
  const kind = n.includes('ghee') ? 'jar' : n.includes('curd') ? 'pot' : n.includes('buffalo') ? 'glass' : p.tags?.includes('Pouch') ? 'pouch' : 'bottle'
  const dark = kind === 'glass'

  return (
    <svg className={`product-art ${className ?? ''}`} viewBox="0 0 300 300" preserveAspectRatio="xMidYMid slice" role="img" aria-label={`${p.name}, ${p.unit}`}>
      <defs>
        {/* lighting + texture filters */}
        <filter id={id('b1')} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.1" /></filter>
        <filter id={id('b3')} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3" /></filter>
        <filter id={id('b8')} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8" /></filter>
        <filter id={id('dof')} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.4" /></filter>
        <filter id={id('grain')} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" stitchTiles="stitch" />
          <feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0.10 0" />
        </filter>
        <filter id={id('marble')} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.004 0.018" numOctaves="5" seed="11" />
          <feColorMatrix values="0 0 0 0 0.55  0 0 0 0 0.56  0 0 0 0 0.55  -2.2 0 0 0 1.25" />
        </filter>
        <filter id={id('wood')} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.003 0.32" numOctaves="3" seed="4" />
          <feColorMatrix values="0 0 0 0 0.16  0 0 0 0 0.09  0 0 0 0 0.04  0 0 0 0.55 0" />
        </filter>
        <filter id={id('clay')} x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="3" seed="3" />
          <feColorMatrix values="0 0 0 0 0.25  0 0 0 0 0.1  0 0 0 0 0.04  0 0 0 0.35 0" />
          <feComposite in2="SourceGraphic" operator="in" />
        </filter>
        <filter id={id('crinkle')} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.018 0.03" numOctaves="2" seed="5" result="t" />
          <feDisplacementMap in="SourceGraphic" in2="t" scale="5" xChannelSelector="R" yChannelSelector="G" />
        </filter>

        {/* shading gradients */}
        <linearGradient id={id('studio')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2f1ed" />
          <stop offset="0.65" stopColor="#e6e4df" />
          <stop offset="1" stopColor="#d6d4ce" />
        </linearGradient>
        <radialGradient id={id('night')} cx="0.55" cy="0.38" r="0.8">
          <stop offset="0" stopColor="#46565c" />
          <stop offset="0.55" stopColor="#25313a" />
          <stop offset="1" stopColor="#0f1519" />
        </radialGradient>
        <linearGradient id={id('table')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6e4729" />
          <stop offset="1" stopColor="#3a2414" />
        </linearGradient>
        <linearGradient id={id('milk')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#c9c9c2" />
          <stop offset="0.07" stopColor="#e3e3dc" />
          <stop offset="0.28" stopColor="#fbfbf7" />
          <stop offset="0.42" stopColor="#ffffff" />
          <stop offset="0.68" stopColor="#efefe9" />
          <stop offset="0.9" stopColor="#d4d4cc" />
          <stop offset="1" stopColor="#b9b9b1" />
        </linearGradient>
        <linearGradient id={id('vshade')} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.35" />
          <stop offset="0.6" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#5d5d55" stopOpacity="0.28" />
        </linearGradient>
        <linearGradient id={id('glass')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#c7d0cf" stopOpacity="0.55" />
          <stop offset="0.2" stopColor="#ffffff" stopOpacity="0.25" />
          <stop offset="0.55" stopColor="#e9eeee" stopOpacity="0.12" />
          <stop offset="1" stopColor="#aab4b3" stopOpacity="0.5" />
        </linearGradient>
        <linearGradient id={id('metal')} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f2f3f3" />
          <stop offset="0.35" stopColor="#8f9598" />
          <stop offset="0.6" stopColor="#d9dcdd" />
          <stop offset="1" stopColor="#6c7275" />
        </linearGradient>
        <radialGradient id={id('porcelain')} cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.6" stopColor="#e3e2dd" />
          <stop offset="1" stopColor="#b9b8b2" />
        </radialGradient>
        <radialGradient id={id('terracotta')} cx="0.35" cy="0.35" r="0.85">
          <stop offset="0" stopColor="#cf8a58" />
          <stop offset="0.55" stopColor="#a65a30" />
          <stop offset="1" stopColor="#6d3317" />
        </radialGradient>
        <linearGradient id={id('ghee')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#b9801a" />
          <stop offset="0.3" stopColor="#ecc35a" />
          <stop offset="0.5" stopColor="#f6d97f" />
          <stop offset="0.8" stopColor="#d9a33a" />
          <stop offset="1" stopColor="#a8700f" />
        </linearGradient>
        <linearGradient id={id('brass')} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#7a5a24" />
          <stop offset="0.3" stopColor="#d8b36a" />
          <stop offset="0.55" stopColor="#f3dca3" />
          <stop offset="1" stopColor="#8a6a2e" />
        </linearGradient>
        <radialGradient id={id('contact')}>
          <stop offset="0" stopColor="#000" stopOpacity="0.55" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={id('vignette')} cx="0.5" cy="0.45" r="0.75">
          <stop offset="0.6" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0.22" />
        </radialGradient>
        <clipPath id={id('frame')}><rect width="300" height="300" /></clipPath>
      </defs>

      <g clipPath={url('frame')}>
        {/* ---------- set ---------- */}
        {!dark ? (
          <>
            <rect width="300" height="300" fill={url('studio')} />
            <rect width="300" height="300" filter={url('marble')} opacity="0.55" />
            {/* window light: hard-ish shadow with a soft penumbra */}
            <path d="M-10 310 L310 92 L310 310 Z" fill="#1d2622" opacity="0.86" filter={url('b3')} />
            <path d="M120 310 L310 180 L310 310 Z" fill="#0f1512" opacity="0.25" filter={url('b8')} />
          </>
        ) : (
          <>
            <rect width="300" height="300" fill={url('night')} />
            <circle cx="62" cy="58" r="18" fill="#fff" opacity="0.07" filter={url('b8')} />
            <circle cx="250" cy="40" r="26" fill="#fff" opacity="0.06" filter={url('b8')} />
            <rect y="226" width="300" height="80" fill={url('table')} />
            <rect y="226" width="300" height="80" filter={url('wood')} />
            <rect y="225" width="300" height="2" fill="#a77a52" opacity="0.6" filter={url('b1')} />
          </>
        )}

        {/* ---------- subjects ---------- */}
        {kind === 'bottle' && (
          <g>
            <ellipse cx="128" cy="270" rx="70" ry="9" fill="#000" opacity="0.18" filter={url('b8')} transform="skewX(-35) translate(190 0)" />
            <ellipse cx="150" cy="266" rx="50" ry="5.5" fill={url('contact')} filter={url('b3')} />
            <path d="M132 66 L168 66 L168 104 C168 120 198 128 198 158 L198 248 C198 259 189 266 178 266 L122 266 C111 266 102 259 102 248 L102 158 C102 128 132 120 132 104 Z" fill={url('glass')} />
            <path d="M135 86 L165 86 L165 105 C165 121 195 129 195 159 L195 247 C195 257 187 263 177 263 L123 263 C113 263 105 257 105 247 L105 159 C105 129 135 121 135 105 Z" fill={url('milk')} />
            <path d="M135 86 L165 86 L165 105 C165 121 195 129 195 159 L195 247 C195 257 187 263 177 263 L123 263 C113 263 105 257 105 247 L105 159 C105 129 135 121 135 105 Z" fill={url('vshade')} />
            <ellipse cx="150" cy="86.5" rx="15" ry="2.2" fill="#ffffff" />
            <path d="M132 66 L168 66 L168 104 C168 120 198 128 198 158 L198 248 C198 259 189 266 178 266 L122 266 C111 266 102 259 102 248 L102 158 C102 128 132 120 132 104 Z" fill="none" stroke="#ffffff" strokeOpacity="0.75" strokeWidth="2.2" filter={url('b1')} />
            <path d="M132 66 L168 66 L168 104 C168 120 198 128 198 158 L198 248 C198 259 189 266 178 266 L122 266 C111 266 102 259 102 248 L102 158 C102 128 132 120 132 104 Z" fill="none" stroke="#56605d" strokeOpacity="0.28" strokeWidth="0.8" />
            {/* speculars */}
            <rect x="112" y="150" width="8" height="98" rx="4" fill="#fff" opacity="0.92" filter={url('b1')} />
            <rect x="124" y="160" width="2.5" height="70" rx="1.2" fill="#fff" opacity="0.6" filter={url('b1')} />
            <path d="M190 162 C192 190 192 220 190 246" stroke="#fff" strokeWidth="2" opacity="0.55" fill="none" filter={url('b1')} />
            <path d="M116 140 C122 128 131 123 136 116" stroke="#fff" strokeWidth="4" opacity="0.85" fill="none" strokeLinecap="round" filter={url('b1')} />
            <rect x="139" y="70" width="4" height="30" rx="2" fill="#fff" opacity="0.7" filter={url('b1')} />
            {/* lip, gasket, porcelain stopper, wire bail */}
            <rect x="129" y="60" width="42" height="9" rx="3" fill={url('glass')} stroke="#fff" strokeOpacity="0.7" />
            <rect x="134" y="56.5" width="32" height="5" rx="2" fill="#b4532f" />
            <path d="M134 57 C134 42 166 42 166 57 Z" fill={url('porcelain')} />
            <path d="M131 64 C117 74 116 98 129 108" stroke={url('metal')} strokeWidth="2.6" fill="none" strokeLinecap="round" />
            <path d="M169 64 C183 74 184 98 171 108" stroke={url('metal')} strokeWidth="2.6" fill="none" strokeLinecap="round" />
            <path d="M136 52 C141 39 159 39 164 52" stroke={url('metal')} strokeWidth="2.4" fill="none" strokeLinecap="round" />
            <path d="M119 80 C118 90 120 98 124 103" stroke="#fff" strokeWidth="0.9" opacity="0.7" fill="none" />
          </g>
        )}

        {kind === 'glass' && (
          <g>
            {/* jug, slightly out of focus behind */}
            <g filter={url('dof')}>
              <ellipse cx="96" cy="250" rx="44" ry="6" fill={url('contact')} />
              <path d="M62 112 L128 112 L124 130 C134 160 134 210 126 244 C124 252 118 256 110 256 L80 256 C72 256 66 252 64 244 C56 210 56 160 66 130 Z" fill={url('porcelain')} />
              <path d="M62 112 L48 102 L72 106 Z" fill="#d9d8d3" />
              <path d="M128 140 C152 146 152 200 128 210" stroke="#cfcec8" strokeWidth="9" fill="none" strokeLinecap="round" />
              <ellipse cx="95" cy="114" rx="32" ry="4.5" fill="#f4f3ee" />
              <rect x="72" y="140" width="7" height="90" rx="3.5" fill="#fff" opacity="0.6" />
            </g>
            {/* tumbler of milk */}
            <ellipse cx="200" cy="274" rx="46" ry="6" fill={url('contact')} filter={url('b3')} />
            <ellipse cx="200" cy="282" rx="32" ry="5" fill="#fff" opacity="0.12" filter={url('b3')} />
            <path d="M160 118 L240 118 L231 262 C230 270 224 274 216 274 L184 274 C176 274 170 270 169 262 Z" fill={url('glass')} />
            <path d="M165 148 L235 148 L227 260 C226 266 221 269 215 269 L185 269 C179 269 174 266 173 260 Z" fill={url('milk')} />
            <path d="M165 148 L235 148 L227 260 C226 266 221 269 215 269 L185 269 C179 269 174 266 173 260 Z" fill={url('vshade')} />
            <ellipse cx="200" cy="148" rx="35" ry="5" fill="#fbfbf7" />
            <ellipse cx="200" cy="148" rx="35" ry="5" fill="none" stroke="#c8c8c0" strokeWidth="0.8" />
            <ellipse cx="200" cy="118" rx="40" ry="5.5" fill="none" stroke="#fff" strokeOpacity="0.7" strokeWidth="1.4" />
            <path d="M160 118 L169 262 M240 118 L231 262" stroke="#fff" strokeOpacity="0.55" strokeWidth="1.6" filter={url('b1')} />
            <rect x="172" y="152" width="7" height="104" rx="3.5" fill="#fff" opacity="0.85" filter={url('b1')} />
            <rect x="222" y="160" width="2.5" height="80" rx="1.2" fill="#fff" opacity="0.5" filter={url('b1')} />
            <path d="M168 124 L172 146" stroke="#fff" strokeWidth="3" opacity="0.6" filter={url('b1')} />
          </g>
        )}

        {kind === 'pouch' && (
          <g>
            <ellipse cx="150" cy="266" rx="66" ry="7" fill={url('contact')} filter={url('b3')} />
            <ellipse cx="120" cy="272" rx="80" ry="10" fill="#000" opacity="0.14" filter={url('b8')} transform="skewX(-30) translate(150 0)" />
            <g filter={url('crinkle')}>
              <path d="M96 80 C96 70 104 64 114 64 L186 64 C196 64 204 70 204 80 L210 236 C211 252 200 262 186 262 L114 262 C100 262 89 252 90 236 Z" fill={url('milk')} />
              <path d="M96 80 C96 70 104 64 114 64 L186 64 C196 64 204 70 204 80 L210 236 C211 252 200 262 186 262 L114 262 C100 262 89 252 90 236 Z" fill={url('vshade')} />
              <rect x="104" y="112" width="92" height="96" rx="6" fill={n.includes('amul') ? '#1f5a9e' : '#24753a'} />
              <rect x="104" y="112" width="92" height="96" rx="6" fill={url('vshade')} />
              <rect x="96" y="64" width="108" height="12" fill="#e9e9e3" />
              <path d="M100 64 v12 M106 64 v12 M112 64 v12 M118 64 v12 M124 64 v12 M130 64 v12 M136 64 v12 M142 64 v12 M148 64 v12 M154 64 v12 M160 64 v12 M166 64 v12 M172 64 v12 M178 64 v12 M184 64 v12 M190 64 v12 M196 64 v12" stroke="#c6c6bf" strokeWidth="1" />
            </g>
            <text x="150" y="146" textAnchor="middle" fontSize="17" fontWeight="800" fill="#fff" fontFamily="'DM Sans', sans-serif" letterSpacing="1">{p.brand.toUpperCase().slice(0, 8)}</text>
            <text x="150" y="166" textAnchor="middle" fontSize="10.5" fontWeight="600" fill="#fff" opacity="0.9" fontFamily="'DM Sans', sans-serif">TONED MILK</text>
            <text x="150" y="192" textAnchor="middle" fontSize="12" fontWeight="700" fill="#fff" fontFamily="'DM Sans', sans-serif">{p.unit}</text>
            <path d="M112 90 C108 140 108 190 114 240" stroke="#fff" strokeWidth="7" opacity="0.75" fill="none" strokeLinecap="round" filter={url('b3')} />
            <path d="M186 96 C190 150 190 200 186 236" stroke="#fff" strokeWidth="3" opacity="0.45" fill="none" filter={url('b1')} />
          </g>
        )}

        {kind === 'pot' && (
          <g>
            <ellipse cx="150" cy="264" rx="62" ry="7" fill={url('contact')} filter={url('b3')} />
            <ellipse cx="120" cy="270" rx="80" ry="10" fill="#000" opacity="0.16" filter={url('b8')} transform="skewX(-30) translate(150 0)" />
            <path d="M90 150 C82 214 110 264 150 264 C190 264 218 214 210 150 Z" fill={url('terracotta')} />
            <path d="M90 150 C82 214 110 264 150 264 C190 264 218 214 210 150 Z" filter={url('clay')} />
            <path d="M96 184 C130 196 170 196 204 184" stroke="#7a3a1a" strokeWidth="1.2" opacity="0.5" fill="none" />
            <path d="M93 168 C130 180 170 180 207 168" stroke="#e0a374" strokeWidth="1" opacity="0.45" fill="none" />
            <ellipse cx="150" cy="150" rx="62" ry="14" fill="#8f4422" />
            <ellipse cx="150" cy="150" rx="62" ry="14" filter={url('clay')} />
            <ellipse cx="150" cy="151" rx="53" ry="10.5" fill="#fbf7ec" />
            <ellipse cx="156" cy="152" rx="30" ry="5" fill="#ffffff" opacity="0.9" filter={url('b3')} />
            <ellipse cx="150" cy="151" rx="53" ry="10.5" fill="none" stroke="#d9d0bb" strokeWidth="1.2" />
            <path d="M106 170 C104 200 112 230 126 248" stroke="#f0b98a" strokeWidth="6" opacity="0.35" fill="none" strokeLinecap="round" filter={url('b3')} />
          </g>
        )}

        {kind === 'jar' && (
          <g>
            <ellipse cx="150" cy="264" rx="58" ry="6.5" fill={url('contact')} filter={url('b3')} />
            <ellipse cx="120" cy="270" rx="70" ry="10" fill="#c48a1c" opacity="0.12" filter={url('b8')} transform="skewX(-30) translate(150 0)" />
            <rect x="100" y="110" width="100" height="154" rx="18" fill={url('glass')} />
            <rect x="104" y="124" width="92" height="136" rx="15" fill={url('ghee')} />
            <rect x="104" y="124" width="92" height="136" rx="15" filter={url('grain')} />
            <rect x="104" y="124" width="92" height="136" rx="15" fill={url('vshade')} />
            <rect x="100" y="110" width="100" height="154" rx="18" fill="none" stroke="#fff" strokeOpacity="0.7" strokeWidth="2" filter={url('b1')} />
            <rect x="108" y="88" width="84" height="26" rx="5" fill={url('brass')} />
            <path d="M112 92 v18 M118 92 v18 M124 92 v18 M130 92 v18 M136 92 v18 M142 92 v18 M148 92 v18 M154 92 v18 M160 92 v18 M166 92 v18 M172 92 v18 M178 92 v18 M184 92 v18" stroke="#6b4f1c" strokeOpacity="0.35" strokeWidth="1" />
            <rect x="114" y="166" width="72" height="50" rx="3" fill="#efe4cc" />
            <rect x="114" y="166" width="72" height="50" rx="3" filter={url('grain')} />
            <text x="150" y="187" textAnchor="middle" fontSize="13" fill="#1f4630" fontFamily="'Instrument Serif', Georgia, serif">A2 Desi Ghee</text>
            <text x="150" y="203" textAnchor="middle" fontSize="6.2" letterSpacing="0.8" fill="#7a6a4a" fontFamily="'DM Sans', sans-serif">BILONA · {p.unit.toUpperCase()}</text>
            <rect x="110" y="128" width="7" height="122" rx="3.5" fill="#fff" opacity="0.6" filter={url('b1')} />
          </g>
        )}

        {/* ---------- lens ---------- */}
        <rect width="300" height="300" fill={url('vignette')} />
        <rect width="300" height="300" filter={url('grain')} />
      </g>
    </svg>
  )
}

/** Hero image for the landing page: the signature bottle on marble. */
export function HeroArt() {
  return <ProductArt p={{ name: 'Fresh milk', brand: 'MooNest', category: 'milk', unit: '500 ml', tags: [], image: 'img/hero.jpg' }} className="hero-art" />
}
