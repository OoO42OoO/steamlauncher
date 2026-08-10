import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  DownloadProgress,
  PublicAccount,
  SessionStatus,
  RedeemResult,
  TaskRead,
} from '@steam-client/shared';
import type { SteamNewsItem } from '../main/api/steam-store';

type UnsubFn = () => void;

function subscribe<T>(channel: string, handler: (payload: T) => void): UnsubFn {
  const wrapped = (_e: IpcRendererEvent, payload: T) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/**
 * Renderer-visible API. This surface is audited to NEVER expose a method that
 * returns AccountRead, login, password, email, maFile, refresh-token, or any
 * similar plaintext credential. Additions that violate that invariant must be
 * rejected in code review.
 */
// Diagnostic-logging flag, read once synchronously at preload load. Lets
// the renderer gate its console diagnostics on the same
// STEAM_CLIENT_LOGGING switch that silences main's electron-log. Wrapped
// so a missing handler (older main) degrades to "logging off" rather than
// throwing during bridge setup.
let loggingEnabled = false;
try {
  loggingEnabled = ipcRenderer.sendSync('debug:logging-enabled') === true;
} catch {
  loggingEnabled = false;
}

const api = {
  debug: {
    /** True only when STEAM_CLIENT_LOGGING=true; renderer diagnostics
     *  check this before writing to the console. */
    loggingEnabled,
  },
  auth: {
    redeem: (code: string): Promise<RedeemResult> =>
      ipcRenderer.invoke('auth:redeem', code),
    status: (): Promise<SessionStatus> => ipcRenderer.invoke('auth:status'),
    logout: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('auth:logout'),
    onStatus: (cb: (s: SessionStatus) => void): UnsubFn =>
      subscribe('auth:status', cb),
  },
  library: {
    list: (): Promise<PublicAccount[]> => ipcRenderer.invoke('library:list'),
  },
  tasks: {
    list: (): Promise<TaskRead[]> => ipcRenderer.invoke('tasks:list'),
    complete: (id: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('tasks:complete', id),
  },
  download: {
    /** Start (or resume) DepotDownloader for the game with this appid. The
     *  library is deduped by appid, so appid is the unique per-game key even
     *  when one pool account owns many games. */
    start: (appid: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('download:start', appid),
    cancel: (appid: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('download:cancel', appid),
    onProgress: (cb: (e: DownloadProgress) => void): UnsubFn =>
      subscribe('download:progress', cb),
  },
  install: {
    /** Wipe the install directory and drop the ledger row. Refuses with
     *  error:'game_running' if the enforcer is still tracking this appid —
     *  the renderer surfaces that as "close the game first". */
    remove: (appid: number): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('install:remove', appid),
    /** Fires after the main process finishes wiping a game. Renderer
     *  re-fetches the library so the card flips from "Play" back to
     *  "Install" without a manual reload. */
    onRemoved: (cb: (e: { appid: number }) => void): UnsubFn =>
      subscribe('install:removed', cb),
    /** Bytes the install occupies on disk, or null when it isn't installed.
     *  Walks the tree, so callers should ask once per game, not per render. */
    size: (appid: number): Promise<number | null> =>
      ipcRenderer.invoke('install:size', appid),
    /** Reveal the install directory in the OS file manager. Main resolves the
     *  path itself; the renderer never supplies one. */
    openFolder: (appid: number): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('install:openFolder', appid),
  },
  game: {
    /** Launch a game by `appid` (the unique per-game key of the clicked
     *  library card — the list is deduped by appid, and one pool account may
     *  own many games). Main resolves the pool account from the matched row.
     *  By default runs a DD -validate update check before launching; pass
     *  `skipUpdateCheck:true` to bypass after the user declines the
     *  post-failure confirm. */
    launch: (
      appid: number,
      opts?: { skipUpdateCheck?: boolean }
    ): Promise<{ ok: boolean; error?: string; message?: string }> =>
      ipcRenderer.invoke(
        'game:launch',
        opts ? { appid, skipUpdateCheck: !!opts.skipUpdateCheck } : appid
      ),
    onLaunchProgress: (
      cb: (e: {
        appid: number;
        phase: 'checking' | 'updating' | 'patching' | 'launching' | 'idle';
        percent: number;
      }) => void
    ): UnsubFn => subscribe('game:launchProgress', cb),
    /** Main signals that DD just began pulling delta bytes — renderer
     *  shows the "Скачать и играть / Играть без обновления" prompt and
     *  answers via sendUpdateDecision. */
    onUpdateAvailable: (cb: (e: { appid: number }) => void): UnsubFn =>
      subscribe('game:update_available', cb),
    /** DRM patch failed (Steamless declined, Goldberg DLL swap errored).
     *  Game can still be launched; the toast warns Steam may be needed. */
    onDrmWarning: (cb: (e: { appid: number; reason: string }) => void): UnsubFn =>
      subscribe('game:drm_warning', cb),
    /** Reply to the update-available prompt. `install: true` lets DD
     *  finish the download; false cancels DD and launches the existing
     *  install untouched. */
    sendUpdateDecision: (
      appid: number,
      install: boolean
    ): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('game:update_decision', { appid, install }),
  },
  ledger: {
    balance: (): Promise<number> => ipcRenderer.invoke('ledger:balance'),
    onBalanceUpdate: (cb: (seconds: number) => void): UnsubFn =>
      subscribe('balance:update', cb),
    /** Richer event carrying source ('local' | 'server') alongside the
     *  seconds value. Fires for both local mutations and server-confirmed
     *  reconciles. Prefer this for new code; `onBalanceUpdate` is kept for
     *  back-compat with the current UI which only needs the number. */
    onBalanceChanged: (
      cb: (e: { seconds: number; source: 'local' | 'server' }) => void
    ): UnsubFn => subscribe('balance:changed', cb),
  },
  session: {
    /** Game-session state: is play unlocked, and for how long. null = unknown
     *  (signed out or API unreachable) — the UI shows nothing rather than
     *  claiming the session lapsed. */
    game: (): Promise<{
      user_id: string;
      is_active: boolean;
      expires_at?: string | null;
      remaining_seconds: number;
    } | null> => ipcRenderer.invoke('session:game'),
    /** Re-check the gate. Returns the verdict rather than the payload, so the
     *  caller can tell "no session yet" apart from "could not reach the
     *  server" — `game` answers null for both. */
    check: (): Promise<'ok' | 'required' | 'unreachable'> =>
      ipcRenderer.invoke('session:check'),
  },
  stats: {
    gameTotals: (): Promise<Array<{ appid: number; name: string; seconds: number }>> =>
      ipcRenderer.invoke('stats:gameTotals'),
  },
  deeplink: {
    /** Pop the redeem code queued from a deeplink opened pre-mount. */
    takeCode: (): Promise<string | null> => ipcRenderer.invoke('deeplink:take-code'),
    /** Subscribe to deeplink redeem codes arriving while the window is open. */
    onRedeem: (cb: (c: { code: string }) => void): UnsubFn =>
      subscribe('deeplink:redeem', cb),
  },
  shell: {
    openExternal: (url: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('shell:openExternal', url),
  },
  steam: {
    /** Fetch Steam Store appdetails (public, no auth). 7-day cache in main. */
    appDetails: (appid: number, locale?: string): Promise<unknown | null> =>
      ipcRenderer.invoke('steam:app-details', { appid, locale }),
    /** Recent announcements for a game. Steam serves them in whatever
     *  language the publisher posted, so there is no locale argument. */
    news: (appid: number): Promise<SteamNewsItem[]> =>
      ipcRenderer.invoke('steam:news', appid),
    /**
     * Genre labels for catalog cards. Returns instantly with the cached
     * subset; misses are fetched in the background and arrive one-by-one
     * via `onGenresUpdate`.
     */
    genres: (
      appids: number[],
      locale?: string
    ): Promise<{ known: Record<number, string[]> }> =>
      ipcRenderer.invoke('steam:genres', { appids, locale }),
    onGenresUpdate: (
      cb: (u: { appid: number; locale: string; genres: string[] }) => void
    ): UnsubFn => subscribe('steam:genres-update', cb),
  },
  settings: {
    get: (): Promise<{
      installRoot: string;
      language: string;
      autoUpdate: boolean;
      favorites: number[];
    }> => ipcRenderer.invoke('settings:get'),
    /** Pin/unpin a game by appid; resolves with the new favourites list. */
    toggleFavorite: (appid: number): Promise<number[]> =>
      ipcRenderer.invoke('settings:toggleFavorite', appid),
    chooseInstallDir: (): Promise<{ ok: boolean; installRoot?: string }> =>
      ipcRenderer.invoke('settings:chooseInstallDir'),
    /**
     * Persist the user's chosen UI language. Pass 'auto' to follow the OS
     * locale, otherwise an ISO 639-1 code from SUPPORTED_LANGUAGES. Returns
     * the code main resolved to — the renderer applies that to i18next.
     */
    setLanguage: (code: string): Promise<string> =>
      ipcRenderer.invoke('settings:setLanguage', code),
    setAutoUpdate: (value: boolean): Promise<boolean> =>
      ipcRenderer.invoke('settings:setAutoUpdate', value),
  },
  updater: {
    onChecking: (cb: () => void): UnsubFn =>
      subscribe<void>('updater:checking', cb),
    onAvailable: (
      cb: (e: { version: string; releaseNotes?: string }) => void
    ): UnsubFn => subscribe('updater:available', cb),
    onNotAvailable: (cb: () => void): UnsubFn =>
      subscribe<void>('updater:not-available', cb),
    onError: (cb: (e: { message: string }) => void): UnsubFn =>
      subscribe('updater:error', cb),
    onDownloadProgress: (
      cb: (e: {
        percent: number;
        transferred: number;
        total: number;
        bytesPerSecond: number;
      }) => void
    ): UnsubFn => subscribe('updater:download-progress', cb),
    onDownloaded: (cb: (e: { version: string }) => void): UnsubFn =>
      subscribe('updater:downloaded', cb),
    installAndRestart: (): Promise<void> =>
      ipcRenderer.invoke('updater:install-and-restart'),
  },
  drmBoot: {
    /** Per-step progress for the boot-time DRM patch sweep. `current` is
     *  1-based; `appid` and `name` describe the game being patched. The
     *  first event of a sweep carries current:0 + nulls so the UI can
     *  mount the toast with the total before the first patch starts. */
    onProgress: (
      cb: (e: {
        total: number;
        current: number;
        appid: number | null;
        name: string | null;
      }) => void
    ): UnsubFn => subscribe('drm-boot:progress', cb),
    /** Sweep finished. UI flips to "done" and auto-dismisses. */
    onDone: (cb: (e: { total: number }) => void): UnsubFn =>
      subscribe('drm-boot:done', cb),
  },
  i18n: {
    /**
     * Read OS locale + saved language override at boot. Renderer calls this
     * before mounting React so the first frame is already localised.
     */
    getEnv: (): Promise<{ osLocale: string; language: string }> =>
      ipcRenderer.invoke('i18n:getEnv'),
  },
  app: {
    getVersion: (): Promise<{ app: string; electron: string; platform: string }> =>
      ipcRenderer.invoke('app:version'),
  },
  window: {
    /** Close the window (runs through Electron's normal close flow). */
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    maximizeToggle: (): Promise<void> =>
      ipcRenderer.invoke('window:maximize-toggle'),
  },
};

contextBridge.exposeInMainWorld('api', api);

/**
 * Runtime feature flags surfaced to the renderer. Pulled once on mount and
 * kept current via the `'feature-flags:changed'` channel — today the change
 * event never fires, but the bridge is in place for the future server poll.
 */
type FeatureFlags = { balanceEnabled: boolean };
const featureFlagsApi = {
  get: (): Promise<FeatureFlags> => ipcRenderer.invoke('feature-flags:get'),
  onChange: (cb: (flags: FeatureFlags) => void): UnsubFn =>
    subscribe('feature-flags:changed', cb),
};
contextBridge.exposeInMainWorld('featureFlags', featureFlagsApi);

export type Api = typeof api;
export type FeatureFlagsApi = typeof featureFlagsApi;
