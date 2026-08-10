/**
 * Steam Store public API client. Used by the renderer (via IPC) to populate
 * the in-app game detail page with screenshots, trailers, descriptions, and
 * system requirements straight from the Steam Store, and by the genre
 * service to label catalog cards. No authentication is required — the
 * endpoint is public but rate-limited (~200 requests / 5 min per IP), so
 * every layer here is built to avoid re-asking:
 *
 *   - 7-day positive cache keyed by `appid:lang`, held in memory and
 *     mirrored to a JSON file under userData (survives restarts — a fresh
 *     boot doesn't re-fetch the whole library).
 *   - 10-minute negative cache for failed fetches so a flaky network or a
 *     rate-limit response doesn't turn into a retry storm.
 *
 * The disk mirror is opt-in via `configureStoreDiskCache` (called from
 * main at boot) — unit tests skip it and run memory-only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import log from 'electron-log/main.js';

// ── Schemas (passthrough — Steam adds fields ad-hoc, we just keep what we use) ──
export const SteamMovieSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    name: z.string().optional(),
    thumbnail: z.string().optional(),
    webm: z
      .object({ '480': z.string().optional(), max: z.string().optional() })
      .partial()
      .optional(),
    mp4: z
      .object({ '480': z.string().optional(), max: z.string().optional() })
      .partial()
      .optional(),
  })
  .passthrough();

export const SteamScreenshotSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    path_thumbnail: z.string().optional(),
    path_full: z.string().optional(),
  })
  .passthrough();

export const SteamReleaseDateSchema = z
  .object({
    coming_soon: z.boolean().optional(),
    date: z.string().optional(),
  })
  .passthrough();

/**
 * Steam emits `{minimum, recommended}` when requirements exist but a bare
 * `[]` when they don't (classic PHP empty-object serialization). Accept
 * both — the array form simply carries no fields. Without the union every
 * old title (e.g. appid 6000) logs a schema-mismatch warning on each
 * detail-page open.
 */
export const SteamRequirementsSchema = z.union([
  z
    .object({
      minimum: z.string().optional(),
      recommended: z.string().optional(),
    })
    .partial()
    .passthrough(),
  z.array(z.unknown()),
]);

export const SteamAppDetailsDataSchema = z
  .object({
    type: z.string().optional(),
    name: z.string(),
    steam_appid: z.number(),
    is_free: z.boolean().optional(),
    short_description: z.string().optional(),
    detailed_description: z.string().optional(),
    about_the_game: z.string().optional(),
    header_image: z.string().optional(),
    capsule_image: z.string().optional(),
    background: z.string().optional(),
    background_raw: z.string().optional(),
    developers: z.array(z.string()).optional(),
    publishers: z.array(z.string()).optional(),
    release_date: SteamReleaseDateSchema.optional(),
    genres: z
      .array(
        z.object({
          id: z.union([z.string(), z.number()]),
          description: z.string(),
        })
      )
      .optional(),
    categories: z
      .array(
        z.object({
          id: z.union([z.string(), z.number()]),
          description: z.string(),
        })
      )
      .optional(),
    pc_requirements: SteamRequirementsSchema.optional(),
    mac_requirements: SteamRequirementsSchema.optional(),
    linux_requirements: SteamRequirementsSchema.optional(),
    platforms: z
      .object({
        windows: z.boolean().optional(),
        mac: z.boolean().optional(),
        linux: z.boolean().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    screenshots: z.array(SteamScreenshotSchema).optional(),
    movies: z.array(SteamMovieSchema).optional(),
    supported_languages: z.string().optional(),
  })
  .passthrough();

export type SteamAppDetailsData = z.infer<typeof SteamAppDetailsDataSchema>;

interface CacheEntry {
  data: SteamAppDetailsData;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const REQUEST_TIMEOUT = 8000;

/** Failed fetches (network error, non-200, empty payload) are remembered
 *  for a short window so bulk callers (genre fill) don't hammer the same
 *  dead appid — but long enough recovery stays automatic. */
const failCache = new Map<string, number>();
const FAIL_TTL = 10 * 60 * 1000; // 10 minutes

// ── Disk mirror ─────────────────────────────────────────────────────────
let diskCacheFile: string | null = null;
let diskCacheLoaded = false;
let diskWriteTimer: NodeJS.Timeout | null = null;

interface DiskCacheShape {
  v: 1;
  entries: Record<string, CacheEntry>;
}

/**
 * Point the store cache at a JSON file (userData). Called once from main
 * at boot, before any renderer request can land. Entries load lazily on
 * first access so tests and cold paths pay nothing.
 */
export function configureStoreDiskCache(file: string): void {
  diskCacheFile = file;
  diskCacheLoaded = false;
}

function loadDiskCache(): void {
  if (diskCacheLoaded || !diskCacheFile) return;
  diskCacheLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(diskCacheFile, 'utf8')) as DiskCacheShape;
    if (raw?.v !== 1 || !raw.entries) return;
    const now = Date.now();
    let hydrated = 0;
    for (const [key, entry] of Object.entries(raw.entries)) {
      if (
        entry &&
        typeof entry.expiresAt === 'number' &&
        entry.expiresAt > now &&
        entry.data &&
        !cache.has(key)
      ) {
        cache.set(key, entry);
        hydrated++;
      }
    }
    if (hydrated > 0) log.info('[steam-store] disk cache hydrated', { hydrated });
  } catch {
    // First run (ENOENT) or corrupt file — start empty; next write heals it.
  }
}

/** Debounced write-behind: bulk genre fills touch the cache dozens of
 *  times in a burst — one file write per second is plenty. */
function scheduleDiskWrite(): void {
  if (!diskCacheFile || diskWriteTimer) return;
  diskWriteTimer = setTimeout(() => {
    diskWriteTimer = null;
    if (!diskCacheFile) return;
    try {
      const shape: DiskCacheShape = { v: 1, entries: Object.fromEntries(cache) };
      writeFileSync(diskCacheFile, JSON.stringify(shape), 'utf8');
    } catch (err) {
      log.warn('[steam-store] disk cache write failed', (err as Error).message);
    }
  }, 1000);
  // Don't keep the process alive just to flush a cache file.
  diskWriteTimer.unref?.();
}

/**
 * Map our i18n locale code to Steam's own language name.
 *
 * Used for the Store's `l=` query and for DepotDownloader's `-language`,
 * which take the same vocabulary.
 */
export function steamLanguageFor(locale: string | undefined): string | undefined {
  if (!locale) return undefined;
  // Region-tagged codes ("ru-RU", "pt_BR") would miss the table and fall back
  // to english silently, which is exactly the failure this map exists to
  // avoid. Match on the base subtag.
  const base = locale.toLowerCase().split(/[-_]/)[0];
  return STEAM_LANGUAGE[base];
}

export const STEAM_LANGUAGE: Record<string, string> = {
  en: 'english',
  ru: 'russian',
  de: 'german',
  fr: 'french',
  es: 'spanish',
  it: 'italian',
  pt: 'portuguese',
  pl: 'polish',
  nl: 'dutch',
  cs: 'czech',
  sk: 'slovak',
  hu: 'hungarian',
  ro: 'romanian',
  bg: 'bulgarian',
  uk: 'ukrainian',
  el: 'greek',
  sv: 'swedish',
  da: 'danish',
  fi: 'finnish',
  nb: 'norwegian',
  tr: 'turkish',
};

/**
 * Fetch app details from the Steam Store. Returns null when the request
 * fails, the appid is unknown, or the response shape is unparseable. The
 * caller (IPC handler) forwards null to the renderer, which renders a
 * "game info unavailable" fallback with a back button.
 */
export async function getAppDetails(
  appid: number,
  locale: string = 'en'
): Promise<SteamAppDetailsData | null> {
  loadDiskCache();
  const lang = steamLanguageFor(locale) ?? 'english';
  const key = `${appid}:${lang}`;

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }
  const failedAt = failCache.get(key);
  if (failedAt !== undefined && failedAt + FAIL_TTL > Date.now()) {
    return null;
  }

  const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&l=${lang}&cc=us`;

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      log.warn('[steam-store] non-200', appid, res.status);
      failCache.set(key, Date.now());
      return null;
    }

    const json = (await res.json()) as Record<
      string,
      { success: boolean; data?: unknown }
    >;
    const entry = json[String(appid)];
    if (!entry || !entry.success || !entry.data) {
      log.info('[steam-store] no data for appid', appid);
      failCache.set(key, Date.now());
      return null;
    }

    const parsed = SteamAppDetailsDataSchema.safeParse(entry.data);
    if (!parsed.success) {
      log.warn(
        '[steam-store] schema mismatch',
        appid,
        parsed.error.issues.slice(0, 3)
      );
      // Best-effort: forward the raw data anyway. Steam occasionally adds
      // mandatory-looking fields we don't list; better to render a partially
      // populated page than to throw the whole response away.
      const fallback = entry.data as SteamAppDetailsData;
      cache.set(key, { data: fallback, expiresAt: Date.now() + TTL });
      scheduleDiskWrite();
      return fallback;
    }
    const data = parsed.data;
    cache.set(key, { data, expiresAt: Date.now() + TTL });
    scheduleDiskWrite();
    return data;
  } catch (err) {
    log.warn(
      '[steam-store] fetch failed',
      appid,
      (err as Error)?.message || err
    );
    failCache.set(key, Date.now());
    return null;
  }
}

/**
 * Cache-only lookup: returns the entry if we already have it (memory or
 * disk mirror), never touches the network. The genre service uses this to
 * answer the renderer synchronously before starting a background fill.
 */
export function peekAppDetails(
  appid: number,
  locale: string = 'en'
): SteamAppDetailsData | null {
  loadDiskCache();
  const lang = steamLanguageFor(locale) ?? 'english';
  const cached = cache.get(`${appid}:${lang}`);
  return cached && cached.expiresAt > Date.now() ? cached.data : null;
}

/** Used by tests to drop cache state (positive, negative, disk) between runs. */
export function clearCache(): void {
  cache.clear();
  failCache.clear();
  diskCacheFile = null;
  diskCacheLoaded = false;
  if (diskWriteTimer) {
    clearTimeout(diskWriteTimer);
    diskWriteTimer = null;
  }
}

export type GamePlatform = 'windows' | 'mac' | 'linux';

/** Map Node's `process.platform` value to Steam's platform identifier. */
export function currentGamePlatform(
  nodePlatform: NodeJS.Platform = process.platform
): GamePlatform | null {
  if (nodePlatform === 'win32') return 'windows';
  if (nodePlatform === 'darwin') return 'mac';
  if (nodePlatform === 'linux') return 'linux';
  return null;
}

/** Extract the Steam-reported platform list from app details. */
export function supportedPlatforms(
  data: SteamAppDetailsData | null | undefined
): GamePlatform[] {
  if (!data?.platforms) return [];
  const out: GamePlatform[] = [];
  if (data.platforms.windows) out.push('windows');
  if (data.platforms.mac) out.push('mac');
  if (data.platforms.linux) out.push('linux');
  return out;
}

// ── News ────────────────────────────────────────────────────────────────
/** One entry from ISteamNews, trimmed to what the game page renders. */
export interface SteamNewsItem {
  gid: string;
  title: string;
  url: string;
  /** Plain-ish text — Steam returns BBCode/HTML here, already truncated. */
  contents: string;
  author: string;
  feedlabel: string;
  /** Unix seconds. */
  date: number;
}

const NEWS_TTL = 60 * 60 * 1000; // 1 hour — announcements land on their own clock
const newsCache = new Map<number, { items: SteamNewsItem[]; expiresAt: number }>();

/**
 * Recent announcements for a game.
 *
 * Separate endpoint from appdetails (`ISteamNews/GetNewsForApp`), public and
 * unauthenticated, and not localized — Steam serves whatever language the
 * publisher posted in, so there is no locale in the cache key. `maxlength`
 * asks Steam to truncate the body server-side; we keep the cache in memory
 * only, since an hour-old announcement isn't worth a disk round-trip.
 *
 * Returns [] rather than null on failure: the section simply doesn't render,
 * and a games-with-no-news response is indistinguishable from a flaky one as
 * far as the page is concerned.
 */
export async function getAppNews(
  appid: number,
  count = 4
): Promise<SteamNewsItem[]> {
  const cached = newsCache.get(appid);
  if (cached && cached.expiresAt > Date.now()) return cached.items;

  const url =
    `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/` +
    `?appid=${appid}&count=${count}&maxlength=220&format=json`;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      log.warn('[steam-news] non-200', appid, res.status);
      return [];
    }
    const json = (await res.json()) as {
      appnews?: { newsitems?: unknown[] };
    };
    const raw = json.appnews?.newsitems ?? [];
    const items: SteamNewsItem[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.title !== 'string' || typeof e.url !== 'string') continue;
      items.push({
        gid: String(e.gid ?? e.url),
        title: e.title,
        url: e.url,
        contents: typeof e.contents === 'string' ? e.contents : '',
        author: typeof e.author === 'string' ? e.author : '',
        feedlabel: typeof e.feedlabel === 'string' ? e.feedlabel : '',
        date: typeof e.date === 'number' ? e.date : 0,
      });
    }
    newsCache.set(appid, { items, expiresAt: Date.now() + NEWS_TTL });
    return items;
  } catch (err) {
    log.warn('[steam-news] fetch failed', appid, (err as Error)?.message || err);
    return [];
  }
}
