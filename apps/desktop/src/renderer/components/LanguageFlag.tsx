/**
 * Compact inline SVG flags for the language picker.
 *
 * Why inline (no package, no external assets): the picker uses a custom
 * dropdown rather than a native <select>, because <option> can't render
 * images — flag emoji work on Linux/macOS but Windows ships with no
 * country-flag glyphs (Segoe UI Symbol's emoji set is missing them),
 * so the dropdown reads as blank on Windows. Inlining 21 SVGs keeps
 * the bundle self-contained and avoids runtime fetches.
 *
 * Each flag is rendered at 20×14 (3:2 aspect) inside the dropdown row.
 * The SVGs are simplified — recognizable stripes and crosses, not pixel-
 * accurate heraldry. 14-px-tall flagicons fit nicely next to 13-px text.
 *
 * Source for the simplified shapes: hand-traced from public-domain flag
 * references (Wikipedia's SVGs simplified to 24×16 viewBox). Approximate
 * proportions and colors are good enough for language identification.
 */
import type { CSSProperties, ReactElement } from 'react';

type FlagKey =
  | 'en'
  | 'ru'
  | 'de'
  | 'fr'
  | 'es'
  | 'pt'
  | 'it'
  | 'pl'
  | 'nl'
  | 'cs'
  | 'sk'
  | 'hu'
  | 'ro'
  | 'bg'
  | 'uk'
  | 'el'
  | 'sv'
  | 'da'
  | 'fi'
  | 'nb'
  | 'tr';

const FLAGS: Record<FlagKey, ReactElement> = {
  // United Kingdom — Union Jack (simplified to crosses + diagonals)
  en: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <clipPath id="uk-c">
        <path d="M0,0 v30 h60 v-30 z" />
      </clipPath>
      <path d="M0,0 v30 h60 v-30 z" fill="#012169" />
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" strokeWidth="6" />
      <path d="M0,0 L60,30 M60,0 L0,30" stroke="#C8102E" strokeWidth="4" clipPath="url(#uk-c)" />
      <path d="M30,0 v30 M0,15 h60" stroke="#fff" strokeWidth="10" />
      <path d="M30,0 v30 M0,15 h60" stroke="#C8102E" strokeWidth="6" />
    </svg>
  ),
  // Russia — white / blue / red horizontal stripes
  ru: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="10" fill="#fff" />
      <rect y="10" width="60" height="10" fill="#0039A6" />
      <rect y="20" width="60" height="10" fill="#D52B1E" />
    </svg>
  ),
  // Germany — black / red / gold horizontal stripes
  de: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="10" fill="#000" />
      <rect y="10" width="60" height="10" fill="#DD0000" />
      <rect y="20" width="60" height="10" fill="#FFCE00" />
    </svg>
  ),
  // France — blue / white / red vertical stripes
  fr: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="20" height="30" fill="#0055A4" />
      <rect x="20" width="20" height="30" fill="#fff" />
      <rect x="40" width="20" height="30" fill="#EF4135" />
    </svg>
  ),
  // Spain — red / yellow / red with yellow band 2x height
  es: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="30" fill="#AA151B" />
      <rect y="7.5" width="60" height="15" fill="#F1BF00" />
    </svg>
  ),
  // Portugal — green 2/5, red 3/5 with coat of arms circle (simplified)
  pt: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="24" height="30" fill="#006600" />
      <rect x="24" width="36" height="30" fill="#FF0000" />
      <circle cx="24" cy="15" r="6" fill="#FFDF00" stroke="#000" strokeWidth="0.5" />
      <circle cx="24" cy="15" r="3" fill="#fff" stroke="#000" strokeWidth="0.3" />
    </svg>
  ),
  // Italy — green / white / red vertical stripes
  it: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="20" height="30" fill="#009246" />
      <rect x="20" width="20" height="30" fill="#fff" />
      <rect x="40" width="20" height="30" fill="#CE2B37" />
    </svg>
  ),
  // Poland — white over red
  pl: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="15" fill="#fff" />
      <rect y="15" width="60" height="15" fill="#DC143C" />
    </svg>
  ),
  // Netherlands — red / white / blue horizontal stripes
  nl: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="10" fill="#AE1C28" />
      <rect y="10" width="60" height="10" fill="#fff" />
      <rect y="20" width="60" height="10" fill="#21468B" />
    </svg>
  ),
  // Czechia — white over red with blue triangle on hoist
  cs: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="15" fill="#fff" />
      <rect y="15" width="60" height="15" fill="#D7141A" />
      <path d="M0,0 L24,15 L0,30 z" fill="#11457E" />
    </svg>
  ),
  // Slovakia — white / blue / red horizontal with coat-of-arms shield
  sk: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="10" fill="#fff" />
      <rect y="10" width="60" height="10" fill="#0B4EA2" />
      <rect y="20" width="60" height="10" fill="#EE1C25" />
      <path d="M22,5 h16 v20 h-16 z" fill="#fff" stroke="#0B4EA2" strokeWidth="0.6" />
      <path d="M22,5 h16 v10 h-16 z" fill="#EE1C25" />
    </svg>
  ),
  // Hungary — red / white / green horizontal
  hu: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="10" fill="#CD2A3E" />
      <rect y="10" width="60" height="10" fill="#fff" />
      <rect y="20" width="60" height="10" fill="#436F4D" />
    </svg>
  ),
  // Romania — blue / yellow / red vertical
  ro: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="20" height="30" fill="#002B7F" />
      <rect x="20" width="20" height="30" fill="#FCD116" />
      <rect x="40" width="20" height="30" fill="#CE1126" />
    </svg>
  ),
  // Bulgaria — white / green / red horizontal
  bg: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="10" fill="#fff" />
      <rect y="10" width="60" height="10" fill="#00966E" />
      <rect y="20" width="60" height="10" fill="#D62612" />
    </svg>
  ),
  // Ukraine — blue / yellow horizontal
  uk: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="15" fill="#0057B7" />
      <rect y="15" width="60" height="15" fill="#FFDD00" />
    </svg>
  ),
  // Greece — 9 stripes blue/white with white cross on blue canton
  el: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
        <rect key={i} y={i * 30 / 9} width="60" height={30 / 9} fill={i % 2 === 0 ? '#0D5EAF' : '#fff'} />
      ))}
      <rect width="20" height={30 / 9 * 5} fill="#0D5EAF" />
      <rect width={30 / 9 * 5} height="20" fill="#fff" />
      <rect width={30 / 9 * 5} height="20" fill="none" stroke="#0D5EAF" strokeWidth="1" />
    </svg>
  ),
  // Sweden — blue with yellow Nordic cross
  sv: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="30" fill="#006AA7" />
      <rect x="18" width="6" height="30" fill="#FECC00" />
      <rect y="12" width="60" height="6" fill="#FECC00" />
    </svg>
  ),
  // Denmark — red with white Nordic cross
  da: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="30" fill="#C8102E" />
      <rect x="18" width="6" height="30" fill="#fff" />
      <rect y="12" width="60" height="6" fill="#fff" />
    </svg>
  ),
  // Finland — white with blue Nordic cross
  fi: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="30" fill="#fff" />
      <rect x="18" width="6" height="30" fill="#003580" />
      <rect y="12" width="60" height="6" fill="#003580" />
    </svg>
  ),
  // Norway — red with white-bordered blue Nordic cross
  nb: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="30" fill="#EF2B2D" />
      <rect x="16" width="10" height="30" fill="#fff" />
      <rect y="10" width="60" height="10" fill="#fff" />
      <rect x="18" width="6" height="30" fill="#002868" />
      <rect y="12" width="60" height="6" fill="#002868" />
    </svg>
  ),
  // Turkey — red with white crescent and star (simplified)
  tr: (
    <svg viewBox="0 0 60 30" aria-hidden="true">
      <rect width="60" height="30" fill="#E30A17" />
      <circle cx="22" cy="15" r="7" fill="#fff" />
      <circle cx="24" cy="15" r="5.5" fill="#E30A17" />
      <polygon points="34,15 35.3,17.5 38,17.7 35.9,19.4 36.6,22 34,20.5 31.4,22 32.1,19.4 30,17.7 32.7,17.5" fill="#fff" />
    </svg>
  ),
};

/** Width × Height in px for the rendered flag — 20×14 keeps the
 *  3:2 aspect of every flag above and lines up with 13-px body text. */
const FLAG_W = 20;
const FLAG_H = 14;

/**
 * The wrapper sizes and clips the flag; the SVG inside is stretched to fill it
 * by the  rule in index.css. Without the clip and that rule
 * the SVG rendered at its own intrinsic size and spilled past the rounded
 * corners, which is what made the picker look ragged.
 */
const baseSvgStyle: CSSProperties = {
  width: FLAG_W,
  height: FLAG_H,
  display: 'inline-block',
  verticalAlign: 'middle',
  borderRadius: 2,
  overflow: 'hidden',
  lineHeight: 0,
  boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.18)',
  flexShrink: 0,
};

/**
 * Render a 20×14 flag for the given supported language code. Returns
 * a transparent placeholder for unknown codes so callers don't need to
 * guard before mounting.
 */
export function LanguageFlag({ code }: { code: string }): ReactElement {
  const node = (FLAGS as Record<string, ReactElement | undefined>)[code];
  if (!node) {
    return (
      <span
        className="lang-flag"
        style={{
          ...baseSvgStyle,
          background: 'rgba(255, 255, 255, 0.06)',
        }}
        aria-hidden="true"
      />
    );
  }
  return (
    <span className="lang-flag" style={baseSvgStyle} aria-hidden="true">
      {node}
    </span>
  );
}