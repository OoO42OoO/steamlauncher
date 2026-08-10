/**
 * User preferences that persist across runs. Stored as JSON (0600) at
 * `paths.settings`. Strictly non-sensitive — keep credentials out.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import log from 'electron-log/main.js';
import { paths, lockFileMode } from './paths';

/**
 * `language: 'auto'` resolves to the OS locale at startup. Any other value
 * (e.g. 'en', 'de', 'ru') is a manual override the user picked in the UI.
 * The actual list of supported codes lives in renderer/i18n; main only
 * stores the string and forwards it.
 */
export interface Settings {
  /** Where DepotDownloader puts downloaded games. Per-appid subdir is
   *  appended by downloader.installPathFor(). */
  installRoot: string;
  /** UI language; 'auto' = follow OS locale. */
  language: string;
  /** Auto-install updates downloaded by electron-updater on app quit.
   *  UI-only toggle for now — main always honours it through the
   *  electron-updater defaults. Default: true. */
  autoUpdate: boolean;
  /** How long a "no update available" DD -validate verdict is trusted
   *  before we re-check on the next launch. 0 disables the cache. */
  updateCheckTtlHours: number;
  /**
   * Appids the user pinned, in the order they appear in the sidebar and the
   * titlebar's quick-switch strip. Persisted so the rail survives a restart —
   * it's the closest thing the launcher has to a home screen.
   */
  favorites: number[];
}

let cache: Settings | null = null;

function defaults(): Settings {
  return {
    installRoot: paths.games,
    language: 'auto',
    autoUpdate: true,
    updateCheckTtlHours: 6,
    favorites: [],
  };
}

/** Settings are merged from disk with a blind spread, so a hand-edited or
 *  half-written file could hand us anything. Favourites drive rendering, so
 *  they get sanitised into a deduped list of positive integers. */
function sanitizeFavorites(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const v of value) {
    const n = Number(v);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

export function getSettings(): Settings {
  if (cache) return cache;
  try {
    if (existsSync(paths.settings)) {
      const raw = readFileSync(paths.settings, 'utf8');
      const parsed = JSON.parse(raw) as Partial<Settings>;
      cache = {
        ...defaults(),
        ...parsed,
        favorites: sanitizeFavorites(parsed.favorites),
      };
      return cache;
    }
  } catch (err) {
    log.warn('[settings] load failed, using defaults:', (err as Error).message);
  }
  cache = defaults();
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  cache = next;
  try {
    writeFileSync(paths.settings, JSON.stringify(next, null, 2));
    lockFileMode(paths.settings, 0o600);
  } catch (err) {
    log.warn('[settings] save failed:', (err as Error).message);
  }
  return next;
}

export function getInstallRoot(): string {
  return getSettings().installRoot;
}
