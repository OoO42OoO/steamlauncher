/**
 * Genre service: labels catalog cards with Steam genres without ever
 * blocking the renderer or spamming the Store API.
 *
 * Resolution order (cheapest and least rate-limited first):
 *   1. Store appdetails disk cache (`peekDetails`) — localized names,
 *      answered synchronously in the IPC handler.
 *   2. PICS appinfo "database" (`getGenreIds`) — ONE batched
 *      getProductInfo round-trip for every miss at once, over the same
 *      Steam client protocol SteamCMD uses. No HTTP rate limits, cached
 *      30 days on disk, locale-neutral IDs mapped via `mapGenreIds`.
 *   3. Store web API (`fetchDetails`) — only for titles PICS has no
 *      genre data for. Sequential queue with a politeness delay
 *      (~200 req / 5 min per IP is Steam's ceiling); results land in
 *      the appdetails disk cache so this is a once-ever cost per title.
 *
 * Contract with the renderer (`steam:genres` IPC):
 *   - The handler answers synchronously from cache; unknown appids are
 *     queued, NOT awaited.
 *   - Each appid resolved later is pushed via the `steam:genres-update`
 *     broadcast — including "no genres" results, so the renderer can
 *     stop treating the appid as pending.
 *
 * Deps are injected so tests stub the seams without bringing up the
 * full main process — same pattern as install-remove.ts.
 */
import log from 'electron-log/main.js';

interface DetailsLike {
  genres?: Array<{ id: string | number; description: string }> | null;
}

export interface GenreServiceDeps {
  /** Cache-only lookup (steam-store.peekAppDetails). */
  peekDetails: (appid: number, locale: string) => DetailsLike | null;
  /** Bulk PICS lookup: appid → Steam genre IDs (steam-app-info.getGenreIds).
   *  Must not throw — returns whatever subset it could resolve. */
  getGenreIds: (appids: number[]) => Promise<Map<number, string[]>>;
  /** Localize genre IDs; unknown IDs drop out (genre-names.genreNamesFor). */
  mapGenreIds: (ids: string[], locale: string) => string[];
  /** Store web API fallback (steam-store.getAppDetails). */
  fetchDetails: (appid: number, locale: string) => Promise<DetailsLike | null>;
  /** Push one resolved appid to the renderer. */
  broadcast: (payload: {
    appid: number;
    locale: string;
    genres: string[];
  }) => void;
  /** Politeness gap between web-API fallback requests. */
  delayMs?: number;
}

export type GenreMap = Record<number, string[]>;

const DEFAULT_DELAY_MS = 400;

function extractGenres(details: DetailsLike | null): string[] {
  if (!details?.genres) return [];
  return details.genres
    .map((g) => (typeof g.description === 'string' ? g.description.trim() : ''))
    .filter((s) => s.length > 0);
}

export class GenreService {
  private readonly deps: GenreServiceDeps;
  /** `${appid}:${locale}` keys somewhere between request() and broadcast —
   *  covers both the PICS phase and the web-API queue. */
  private readonly pending = new Set<string>();
  /** FIFO of web-API fallback fetches (PICS couldn't answer these). */
  private readonly queue: Array<{ appid: number; locale: string }> = [];
  private draining = false;

  constructor(deps: GenreServiceDeps) {
    this.deps = deps;
  }

  /**
   * Cache-only answer + background fill for the rest. Never awaits the
   * network — the renderer paints instantly with what we know and the
   * misses stream in via broadcast.
   */
  request(appids: number[], locale: string): { known: GenreMap } {
    const known: GenreMap = {};
    const misses: number[] = [];
    for (const appid of appids) {
      const cached = this.deps.peekDetails(appid, locale);
      if (cached !== null) {
        known[appid] = extractGenres(cached);
        continue;
      }
      const key = `${appid}:${locale}`;
      if (!this.pending.has(key)) {
        this.pending.add(key);
        misses.push(appid);
      }
    }
    if (misses.length > 0) void this.resolveMisses(misses, locale);
    return { known };
  }

  /** Phase 2: one batched PICS lookup; only its leftovers go to phase 3. */
  private async resolveMisses(appids: number[], locale: string): Promise<void> {
    let picsIds: Map<number, string[]>;
    try {
      picsIds = await this.deps.getGenreIds(appids);
    } catch (err) {
      // getGenreIds is contracted not to throw, but a broken dep must
      // not strand every pending appid — fall through to the web queue.
      log.warn('[genres] PICS lookup threw', (err as Error).message);
      picsIds = new Map();
    }
    for (const appid of appids) {
      const ids = picsIds.get(appid);
      const names =
        ids && ids.length > 0 ? this.deps.mapGenreIds(ids, locale) : [];
      if (names.length > 0) {
        this.pending.delete(`${appid}:${locale}`);
        this.deps.broadcast({ appid, locale, genres: names });
      } else {
        // PICS had nothing usable (unknown appid, no genre block, or
        // only IDs our table doesn't map). Ask the Store web API once —
        // it returns Steam's authoritative localized names.
        this.queue.push({ appid, locale });
      }
    }
    void this.drain();
  }

  /** Phase 3: sequential web-API fallback with a politeness delay. */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let item: { appid: number; locale: string } | undefined;
      while ((item = this.queue.shift()) !== undefined) {
        const { appid, locale } = item;
        try {
          const details = await this.deps.fetchDetails(appid, locale);
          // Broadcast failures as [] too: the renderer must not wait
          // forever on an appid Steam has no data for. The negative
          // cache in steam-store keeps the eventual retry cheap.
          this.deps.broadcast({
            appid,
            locale,
            genres: extractGenres(details),
          });
        } catch (err) {
          log.warn('[genres] fetch failed', {
            appid,
            err: (err as Error).message,
          });
          this.deps.broadcast({ appid, locale, genres: [] });
        } finally {
          this.pending.delete(`${appid}:${locale}`);
        }
        if (this.queue.length > 0) {
          const delay = this.deps.delayMs ?? DEFAULT_DELAY_MS;
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
