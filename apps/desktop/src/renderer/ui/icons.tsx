/**
 * The launcher's icon set.
 *
 * Hand-rolled inline SVG rather than an icon package: the whole set is a few
 * hundred bytes, ships no dependency, and inherits colour via `currentColor`
 * and size via the `size` prop. Every glyph is drawn on a 24×24 grid with a
 * 1.8 stroke so they sit together evenly.
 *
 * Exception: `IconTelegram` is Telegram's own mark (from simple-icons) and is
 * a filled path — a hand-drawn paper plane reads as "send", not as Telegram,
 * and the bot link needs to be unmistakable.
 */
import type { SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Square size in px. Defaults to 16. */
  size?: number;
}

/** Shared attributes for the stroked glyphs. */
function strokeProps({ size = 16, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    ...rest,
  };
}

export function IconLock(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export function IconTelegram({ size = 16, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      {...rest}
    >
      <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
    </svg>
  );
}

export function IconKey(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m20 3-9 9" />
      <path d="m15 8 2.5 2.5L20 8l-2.5-2.5" />
    </svg>
  );
}

export function IconPlay({ size = 16, ...rest }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...rest}>
      <path d="M6 4l14 8-14 8z" />
    </svg>
  );
}

export function IconStar({ size = 16, filled = false, ...rest }: IconProps & { filled?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z" />
    </svg>
  );
}

export function IconChevronDown(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function IconChevronRight(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

export function IconChevronLeft(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="m15 18-6-6 6-6" />
    </svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="m5 12 5 5L20 7" />
    </svg>
  );
}

export function IconShieldCheck(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}

export function IconSearch(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function IconGrid(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <rect x="3" y="4" width="7" height="7" rx="1.5" />
      <rect x="14" y="4" width="7" height="7" rx="1.5" />
      <rect x="3" y="15" width="7" height="5" rx="1.5" />
      <rect x="14" y="15" width="7" height="5" rx="1.5" />
    </svg>
  );
}

export function IconLibrary(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="M4 7h16v13H4z" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}

export function IconDownload(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}

export function IconTasks(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}

export function IconStats(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  );
}

export function IconGear(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  );
}

export function IconPlus(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconInfo(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-5M12 8h.01" />
    </svg>
  );
}

export function IconRefresh(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

export function IconFolder(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="M4 7h6l2 2h8v10H4z" />
    </svg>
  );
}

export function IconTrash(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13" />
    </svg>
  );
}

export function IconClock(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function IconMonitor(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <rect x="2" y="4" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 18v3" />
    </svg>
  );
}

export function IconBolt(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="m13 2-9 12h7l-1 8 9-12h-7z" />
    </svg>
  );
}

export function IconX(p: IconProps) {
  return (
    <svg {...strokeProps(p)}>
      <path d="M5 5l14 14M19 5L5 19" />
    </svg>
  );
}
