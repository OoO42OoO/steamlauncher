/**
 * Steam AppInfo service.
 *
 * Resolves per-game install + launch metadata from Valve's product info
 * feed (the same `appinfo.vdf` blobs SteamDB / SteamCMD display). Used to
 * drive DRM-patcher placement without falling back on heuristic exe
 * walks, and to surface a single source of truth for which DLL arch
 * needs to be dropped next to a given game exe.
 *
 * The fields we care about (mirrors what SteamDB shows under the
 * "Configuration → Launch Options" tab on every appid):
 *
 *   config.installdir       — root folder under steamapps/common/
 *   config.launch[*]        — array of { executable, config { oslist, osarch } }
 *
 * We pick ONE launch config per game, filtered by `oslist == "windows"`,
 * preferring x64 over x86 when both exist (matches Steam's own default
 * for multi-arch titles — we don't accidentally launch the 32-bit twin
 * when the user could run the 64-bit one).
 *
 * Data flow:
 *   1. Cache hit on disk → return synchronously after `await`.
 *   2. Cache miss → fetch `getProductInfo([appid])` from a long-lived
 *      anonymous SteamUser, parse the relevant subtree, write back.
 *   3. Total failures propagate as null so the caller (DRM patcher) can
 *      keep its best-effort contract.
 *
 * Connection: steam-user 5.x supports anonymous login via `logOn({})`,
 * which is the same path SteamCMD uses for `app_info_print`. No
 * credentials needed.
 *
 * Threading: module-singleton-friendly but not enforced; multiple
 * instances are safe (each owns its own SteamUser). Tests pass a
 * `fetcher` and skip real networking.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import SteamUser from 'steam-user';
import log from 'electron-log/main.js';
import { paths } from './paths';

export type GameArch = 'x86' | 'x64';

export interface LaunchInfo {
  /** `steamapps/common/<installdir>/`. */
  installdir: string;
  /** Path to the launch exe, relative to <installdir>. Always uses '\' as
   *  the path separator because that's what appinfo.vdf emits. Callers
   *  that go cross-platform should normalize via `path.join` /
   *  `path.posix.join` as appropriate. */
  launchExe: string;
  /** Arch of `launchExe` from the entry's `osarch`, when Valve set it.
   *  `null` when the launch entry omits `osarch` (old titles like Republic
   *  Commando ship a bare `executable` with no config block) — the caller
   *  then PE-detects the real arch from the resolved exe. */
  arch: GameArch | null;
}

interface CacheShape {
  v: 1;
  apps: Record<string, LaunchInfo & { ts: number }>;
  /**
   * appid → Steam Store genre IDs from `common.genres` (locale-neutral,
   * so one entry serves every UI language). `ids: []` is a cached
   * negative — PICS had no genre data for the appid; we won't re-ask
   * until the TTL lapses. Optional so pre-genre cache files stay valid.
   */
  genres?: Record<string, { ids: string[]; ts: number }>;
}

const CACHE_FILENAME = 'steam-appinfo.json';
/** Re-fetch after this many days. AppInfo launch configs rarely change
 *  (typically only on game updates), but a freshly-moved game on Steam
 *  may resolve differently for the first few hours — long-enough TTL
 *  not to thrash, short-enough not to ship broken data. */
const TTL_MS = 30 * 24 * 3600 * 1000;

/** Connect timeout. Steam is usually up in <5s on a warm connection;
 *  a hard cap protects callers from silent hangs when CM is down. */
const CONNECT_TIMEOUT_MS = 30_000;

/** Hard ceiling on a single PICS `getProductInfo` round-trip. Steam's
 *  own internal timeout for PICS is generous (60–120s on slow cells)
 *  and the client doesn't always honour it — wrap with our own so a
 *  single hung round-trip can't block the install path. */
const PICS_TIMEOUT_MS = 30_000;

/** Single-appid fetch contract. Test seams inject one of these to avoid
 *  touching the Steam network. */
export type LaunchFetcher = (
  appid: number
) => Promise<LaunchInfo | null>;

/** SteamUser factory seam; lets tests stub out the Steam client. */
export type SteamUserFactory = () => SteamClientHandle;

/** Minimal SteamUser surface that the appinfo service needs.
 *  Defined as an interface so tests can supply a stub without depending
 *  on the DoctorMcKay `steam-user` package's internal types. */
export interface SteamClientHandle {
  /** SteamUser 5.x emits 'loggedOn' when anonymous/full session is up. */
  on(event: 'loggedOn', listener: () => void): void;
  on(event: 'error', listener: (err: unknown) => void): void;
  once(event: 'loggedOn', listener: () => void): void;
  once(event: 'error', listener: (err: unknown) => void): void;
  off(event: 'loggedOn', listener: () => void): void;
  off(event: 'error', listener: (err: unknown) => void): void;
  /** SteamUser 5.x accepts `logOn({})` for anonymous sessions. */
  logOn(details: Record<string, unknown>): void;
  /** Tear down the session — used by `shutdown` and the connect timer. */
  logOff(): void;
  /**
   * PICS lookup. steam-user invokes the callback with SPREAD result
   * fields — `cb(err, apps, packages, unknownApps, unknownPackages)` —
   * NOT a single `{ apps }` object (see @doctormckay/stdlib
   * timeoutCallbackPromise, which maps the named fields to positional
   * args). We only read the first one.
   */
  getProductInfo(
    apps: number[],
    packages: number[],
    inclTokens: boolean,
    cb: (
      err: Error | null,
      apps?: Record<string, { appinfo?: unknown }>
    ) => void
  ): void;
}

/** Subset of getProductInfo's response shape — only what we read. */
export interface PicsAppResult {
  apps?: Record<string, { appinfo?: unknown }>;
}

export interface SteamAppInfoOptions {
  /** Override cache file location. Default: `<paths.cache>/steam-appinfo.json`. */
  cachePath?: string;
  /** Test seam: skip the Steam login flow and use this fetcher. */
  fetcher?: LaunchFetcher;
  /** Test seam: bulk PICS lookup for `getGenreIds` without a Steam login. */
  genreFetcher?: (appids: number[]) => Promise<PicsAppResult>;
  /** Test seam: skip instantiating the real steam-user client (and
   *  therefore `connect()` returning a never-resolving promise if hit). */
  createClient?: () => SteamClientHandle;
  /** Test seam: don't write to disk on save. */
  readOnly?: boolean;
  /** Test seam: override the PICS round-trip timeout. Production code
   *  always uses the 30s default; tests can shrink it to keep wall-clock
   *  time bounded. The connect timeout is separate — see
   *  `connectTimeoutMs`. */
  picsTimeoutMs?: number;
  /** Test seam: override the anonymous-login connect timeout. Same
   *  production-vs-test split as `picsTimeoutMs`. */
  connectTimeoutMs?: number;
}

/**
 * Process-local cache of `appid` → launch info. Built once in the
 * constructor from disk, refreshed lazily on miss / TTL expiry. Exposes
 * `getLaunchInfo()` as the only caller-facing method.
 */
export class SteamAppInfoService {
  private cache: CacheShape = { v: 1, apps: {} };
  private readonly cachePath: string;
  private readonly picsTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private client: SteamClientHandle | null = null;
  private clientReady: Promise<SteamClientHandle> | null = null;
  private readonly fetcher: LaunchFetcher | undefined;
  private readonly genreFetcher:
    | ((appids: number[]) => Promise<PicsAppResult>)
    | undefined;
  private readonly createClient: SteamUserFactory | undefined;
  private readonly readOnly: boolean;

  constructor(opts: SteamAppInfoOptions = {}) {
    this.cachePath = opts.cachePath ?? join(paths.cache, CACHE_FILENAME);
    this.fetcher = opts.fetcher;
    this.genreFetcher = opts.genreFetcher;
    this.createClient = opts.createClient;
    this.readOnly = !!opts.readOnly;
    this.picsTimeoutMs = opts.picsTimeoutMs ?? PICS_TIMEOUT_MS;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.loadCache();
  }

  /** Force-fetched on cold call. Stale entries inside TTL aren't re-fetched. */
  async getLaunchInfo(appid: number): Promise<LaunchInfo | null> {
    if (!Number.isInteger(appid) || appid <= 0) return null;
    const key = String(appid);
    const hit = this.cache.apps[key];
    if (hit && Date.now() - hit.ts < TTL_MS) {
      // Strip ts from the returned shape so callers don't accidentally
      // serialise it back into their own state.
      const { ts, ...rest } = hit;
      void ts;
      return rest;
    }
    let fresh: LaunchInfo | null = null;
    try {
      fresh = this.fetcher
        ? await this.fetcher(appid)
        : await this.fetchViaSteam(appid);
    } catch (err) {
      log.warn('[steam-app-info] fetch failed', appid, (err as Error).message);
      return null;
    }
    if (fresh) {
      this.cache.apps[key] = { ...fresh, ts: Date.now() };
      this.saveCache();
    }
    return fresh;
  }

  /** Insert (or overwrite) an entry. Used by tests; lets the DRM patcher
   *  pre-seed the cache when another layer (SteamCMD sidecar, manual
   *  curation) has the data already. */
  put(appid: number, info: LaunchInfo): void {
    this.cache.apps[String(appid)] = { ...info, ts: Date.now() };
    this.saveCache();
  }

  /** Useful for tests: read-only view of the in-memory cache. */
  snapshot(): Record<number, LaunchInfo> {
    const out: Record<number, LaunchInfo> = {};
    for (const [k, v] of Object.entries(this.cache.apps)) {
      const { ts, ...rest } = v;
      void ts;
      out[Number(k)] = rest;
    }
    return out;
  }

  /** Async disable. Safe to call multiple times. */
  async shutdown(): Promise<void> {
    if (this.clientReady) {
      try { await this.clientReady; } catch { /* ignore */ }
    }
    if (this.client) {
      try { this.client.logOff(); } catch { /* ignore */ }
      this.client = null;
    }
    this.clientReady = null;
  }

  /**
   * Bulk appid → Steam genre IDs. This is the "local database" layer of
   * the catalog genre filter: one PICS `getProductInfo` round-trip for
   * ALL cache misses (the protocol is built for batch lookups — it's how
   * the real Steam client hydrates a library), cached for TTL_MS, so the
   * rate-limited Store web API is only ever consulted for titles PICS
   * has no genre data for.
   *
   * Never throws: on connect/PICS failure it returns whatever the cache
   * had, and the caller falls back to its own path for the rest.
   */
  async getGenreIds(appids: number[]): Promise<Map<number, string[]>> {
    const out = new Map<number, string[]>();
    const genres = (this.cache.genres ??= {});
    const misses: number[] = [];
    for (const appid of appids) {
      if (!Number.isInteger(appid) || appid <= 0) continue;
      const hit = genres[String(appid)];
      if (hit && Date.now() - hit.ts < TTL_MS) {
        out.set(appid, hit.ids);
      } else if (!misses.includes(appid)) {
        misses.push(appid);
      }
    }
    if (misses.length === 0) return out;

    let result: PicsAppResult;
    try {
      result = this.genreFetcher
        ? await this.genreFetcher(misses)
        : await this.productInfo(misses);
    } catch (err) {
      log.warn(
        '[steam-app-info] bulk genre fetch failed',
        (err as Error).message
      );
      return out;
    }
    for (const appid of misses) {
      const ids = parseGenreIds(result.apps?.[String(appid)]?.appinfo);
      // Cache negatives too: an appid PICS doesn't know today won't be
      // re-asked until the TTL lapses.
      genres[String(appid)] = { ids, ts: Date.now() };
      out.set(appid, ids);
    }
    this.saveCache();
    return out;
  }

  private async fetchViaSteam(appid: number): Promise<LaunchInfo | null> {
    const result = await this.productInfo([appid]);
    const appinfo = result.apps?.[String(appid)]?.appinfo;
    return parseLaunchInfo(appinfo);
  }

  /**
   * One PICS round-trip, raced against a hard timeout. steam-user doesn't
   * promise a per-call timeout, and callers sit on user-facing paths
   * (Play button, catalog genre fill) — silently hanging here would look
   * like the launcher is busted.
   */
  private async productInfo(appids: number[]): Promise<PicsAppResult> {
    const client = await this.ensureClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const picsTimeout = this.picsTimeoutMs;
    try {
      return await Promise.race<PicsAppResult>([
        new Promise<PicsAppResult>((resolve, reject) => {
          client.getProductInfo(appids, [], false, (err, apps) => {
            if (timer) clearTimeout(timer);
            if (err) reject(err);
            else resolve({ apps: apps ?? {} });
          });
        }),
        new Promise<PicsAppResult>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(
              `getProductInfo timeout (>${picsTimeout}ms) for appids=${appids.join(',')}`
            ));
          }, picsTimeout);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private ensureClient(): Promise<SteamClientHandle> {
    if (this.client) return Promise.resolve(this.client);
    if (this.clientReady) return this.clientReady;
    this.clientReady = this.connect().catch((err) => {
      this.clientReady = null;
      throw err;
    });
    return this.clientReady;
  }

  private connect(): Promise<SteamClientHandle> {
    return new Promise((resolve, reject) => {
      let client: SteamClientHandle;
      try {
        client = this.createClient
          ? this.createClient()
          : (new SteamUser({
              dataDirectory: null,
              autoRelogin: false,
            }) as unknown as SteamClientHandle);
      } catch (err) {
        reject(err as Error);
        return;
      }
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        client.off('loggedOn', onLoggedOn);
        client.off('error', onError);
        if (timer) clearTimeout(timer);
      };
      const onLoggedOn = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.client = client;
        resolve(client);
      };
      const onError = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        try { client.logOff(); } catch { /* ignore */ }
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      client.once('loggedOn', onLoggedOn);
      client.once('error', onError);
      try {
        // `anonymous: true` is the explicit spelling of `logOn({})` —
        // same anonymous session, minus steam-user's stdout warning.
        client.logOn({ anonymous: true });
      } catch (err) {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err as Error);
        return;
      }
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        try { client.logOff(); } catch { /* ignore */ }
        reject(new Error(`steam-user connect timeout (>${this.connectTimeoutMs}ms)`));
      }, this.connectTimeoutMs);
    });
  }

  private loadCache(): void {
    try {
      const raw = readFileSync(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw) as CacheShape;
      if (parsed?.v === 1 && parsed.apps && typeof parsed.apps === 'object') {
        this.cache = parsed;
      } else {
        log.info(
          '[steam-app-info] cache schema mismatch — starting fresh',
          this.cachePath
        );
      }
    } catch (err) {
      // ENOENT on first launch is expected; anything else is logged at
      // info level rather than warn since the service has a clean
      // recovery path (re-fetch + re-save).
      log.info(
        '[steam-app-info] cache unreadable, starting fresh:',
        this.cachePath,
        (err as Error).message
      );
    }
  }

  private saveCache(): void {
    if (this.readOnly) return;
    try {
      writeFileSync(this.cachePath, JSON.stringify(this.cache, null, 2));
    } catch (err) {
      log.warn(
        '[steam-app-info] failed to persist cache',
        this.cachePath,
        (err as Error).message
      );
    }
  }
}

/**
 * Pull the relevant bits out of an appinfo buffer.
 *
 * Valve's numeric-keyed blocks (`launch`, `depots`, etc.) end up with
 * the numeric key as a string in the parsed JSON — e.g. `launch` looks
 * like `{ "0": { ... }, "1": { ... } }`. Object.values() handles that
 * uniformly.
 *
 * Picks the WINDOWS launch entry, preferring the highest arch (x64 > x86 >
 * unknown). If there's no usable Windows launch (e.g. macOS-only title),
 * returns null so the caller can fall back to its heuristic.
 *
 * Old titles (e.g. Republic Commando, 2005) ship a bare launch entry —
 * just `executable`, with no `config` block at all, so neither `oslist`
 * nor `osarch` is present. We must NOT drop those: when the entry omits
 * `oslist` we fall back to the app-level `common.oslist` to decide the
 * platform, and when it omits `osarch` we return `arch: null` and let the
 * caller PE-detect the bitness from the resolved exe. Requiring both was
 * the bug that made these games fall through to the filename heuristic,
 * which then picked the game's launcher wrapper (`LaunchRC.exe`) instead
 * of the real executable.
 */
export function parseLaunchInfo(appinfo: unknown): LaunchInfo | null {
  if (!appinfo || typeof appinfo !== 'object') return null;
  const root = appinfo as Record<string, unknown>;
  const config = root.config;
  if (!config || typeof config !== 'object') return null;
  const cfg = config as Record<string, unknown>;
  const installdir = cfg.installdir;
  const launch = cfg.launch;
  if (typeof installdir !== 'string' || !installdir) return null;
  if (!launch || typeof launch !== 'object') return null;

  // App-level platform, used when a launch entry omits its own oslist.
  const common = root.common as Record<string, unknown> | undefined;
  const commonOslist =
    typeof common?.oslist === 'string' ? common.oslist.toLowerCase() : '';
  const appIsWindows =
    commonOslist === '' || commonOslist.split(/[ ,]+/).includes('windows');

  let best: { exe: string; arch: GameArch | null; archRank: number } | null =
    null;
  for (const entry of Object.values(launch as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const exe = e.executable;
    if (typeof exe !== 'string' || !exe) continue;
    const sub = (e.config as Record<string, unknown> | undefined) ?? {};
    const oslist =
      typeof sub.oslist === 'string' ? sub.oslist.toLowerCase() : '';
    // Honour a declared oslist; if absent, defer to the app-level platform.
    const entryIsWindows = oslist
      ? oslist.split(/[ ,]+/).includes('windows')
      : appIsWindows;
    if (!entryIsWindows) continue;
    const osarch =
      typeof sub.osarch === 'string' ? sub.osarch.trim() : '';
    const arch: GameArch | null =
      osarch === '64' ? 'x64' : osarch === '32' ? 'x86' : null;
    // Prefer a known x64 over x86 over an unknown-arch entry.
    const rank = arch === 'x64' ? 2 : arch === 'x86' ? 1 : 0;
    if (!best || rank > best.archRank) {
      best = { exe, arch, archRank: rank };
    }
  }
  if (!best) return null;
  return {
    installdir,
    launchExe: best.exe,
    arch: best.arch,
  };
}

/**
 * Extract Steam Store genre IDs from an appinfo tree. PICS carries them
 * under `common.genres` as a numeric-keyed block of ID strings, e.g.
 * `{ "0": "1", "1": "23" }` (Action, Indie); some titles only set
 * `common.primary_genre`. Locale-neutral by design — mapping IDs to
 * translated labels is the caller's concern (see genre-names.ts).
 */
export function parseGenreIds(appinfo: unknown): string[] {
  if (!appinfo || typeof appinfo !== 'object') return [];
  const common = (appinfo as Record<string, unknown>).common;
  if (!common || typeof common !== 'object') return [];
  const c = common as Record<string, unknown>;
  const out: string[] = [];
  const push = (v: unknown) => {
    const s =
      typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
    if (s && /^\d+$/.test(s) && !out.includes(s)) out.push(s);
  };
  if (c.genres && typeof c.genres === 'object') {
    for (const v of Object.values(c.genres as Record<string, unknown>)) push(v);
  }
  if (out.length === 0) push(c.primary_genre);
  return out;
}

/** Process-local singleton for callers that don't want to manage one
 *  explicitly. Kept as a function so tests can override. */
let singleton: SteamAppInfoService | null = null;
export function defaultSteamAppInfoService(): SteamAppInfoService {
  if (!singleton) singleton = new SteamAppInfoService();
  return singleton;
}

/**
 * Test-only: drop the cached singleton so the next `defaultSteamAppInfoService()`
 * call returns a fresh instance. Safe to call from `beforeEach`; the
 * production code never invokes this.
 */
export function _resetDefaultSteamAppInfoService(): void {
  if (singleton) {
    void singleton.shutdown().catch(() => {
      /* best-effort */
    });
    singleton = null;
  }
}
