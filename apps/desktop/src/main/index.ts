import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { dirname, join, resolve, sep } from 'node:path';
import {
  type Dirent,
  appendFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import log from 'electron-log/main.js';

import { ensurePaths, paths, selfHealWindowsAcl } from './paths';
import { applyDrmPatches, needsDrmPatching } from './drm-patcher';
import { findGameExe, hasGameExe } from './find-game-exe';
import { detectExeArch, type ExeArch } from './exe-arch';
import {
  getServerToken,
  startTokenIpcServer,
  stopTokenIpcServer,
} from './server-token';
import { installNativeMessagingManifests } from './native-messaging-install';
import { installLogRedactor } from './log-redactor';
import { installSyncLog } from './sync-log';
import { isLoggingEnabled, disableAllLogTransports } from './logging';
import { installSecurity } from './security';
import { ApiClient, ApiError } from './api/client';
import {
  getAppDetails as getSteamAppDetails,
  steamLanguageFor,
  getAppNews as getSteamAppNews,
  peekAppDetails as peekSteamAppDetails,
  configureStoreDiskCache,
  currentGamePlatform,
  supportedPlatforms,
} from './api/steam-store';
import { GenreService } from './genres';
import { genreNamesFor } from './genre-names';
import { defaultSteamAppInfoService } from './steam-app-info';
import { configureVault } from './vault';

// Load .env from repo root or apps/desktop/. Node 20.6+ built-in.
for (const candidate of [
  resolve(import.meta.dirname, '../../.env'),
  resolve(import.meta.dirname, '../../../../.env'),
  resolve(process.cwd(), '.env'),
]) {
  if (existsSync(candidate)) {
    try {
      // Must happen before the logging gate below reads
      // STEAM_CLIENT_LOGGING — so this block stays silent (no log.* yet)
      // to avoid writing a line before transports are configured.
      process.loadEnvFile(candidate);
      break;
    } catch {
      // Ignore a malformed .env — missing vars fall back to their
      // built-in defaults, and logging isn't configured yet anyway.
    }
  }
}

import {
  extractDeeplinkFromArgv,
  parseDeeplink,
  setPendingCode,
  takePendingCode,
} from './deeplink';
import {
  clearUserTables,
  closeLedger,
  configureBalanceSync,
  earn,
  getBalance,
  getInstall,
  getLastUpdateCheck,
  getServerBalance,
  hasLedgerReason,
  initLedger,
  listInstalls,
  onBalanceChange,
  reconcileWithServer,
  recordUpdateCheck,
  recoverOrphanedSessions,
  removeInstall,
  seedGameBaseline,
  seedSiteTime,
  sumPlaySecondsByApp,
  upsertInstall,
} from './ledger';
import { pushWs, startServer, stopServer } from './server';
import { logOffSteam } from './steam-login';
import {
  cancelDownload,
  configureEmailAuthCodes,
  dirBytes,
  installPathFor,
  isDownloading,
  startDownload,
} from './downloader';
import { isInstallComplete } from './download-complete';
import { checkGameSession, type GameSessionVerdict } from './game-session';
import { dedupeByAppid } from './library-dedupe';
import { getInstallRoot, getSettings, updateSettings } from './settings';
import { apiBaseUrl } from './endpoints';
import { resolveActiveLanguage, tMain } from './i18n';
import {
  clearStoredUser,
  loadStoredUser,
  saveStoredUser,
} from './session-store';
import {
  adoptSpawnedPid,
  getEnforcingAppid,
  processNamesForExe,
  startEnforcing,
  stopEnforcing,
} from './enforcer';
import { uninstallGame } from './install-remove';
import { applyDownloadProgress } from './library-cache';
import { startMetricsFlush, stopMetricsFlush } from './metrics';
import { initTray } from './tray';
import { initUpdater } from './updater';
import {
  configureFeatureFlags,
  onFeatureFlagsChange,
  refreshFeatureFlags,
  type FeatureFlags,
} from './feature-flags';
import {
  type PublicAccount,
  type SessionStatus,
  type UserRead,
  type RedeemResult,
  type TaskRead,
  type DownloadProgress,
} from '@steam-client/shared';
import type {
  AccountAvailableRead,
  AccountRead,
} from '@steam-client/shared/api';

// ── Diagnostic logging is opt-in (STEAM_CLIENT_LOGGING=true). Off by
//    default in prod: silence every transport so `log.*` is a no-op and
//    nothing is written to disk/console. When on, install the secret
//    redactor BEFORE the first log line and mirror to the sync shadow
//    log. ───────────────────────────────────────────────────────────────
if (isLoggingEnabled()) {
  installLogRedactor();
  installSyncLog(paths.logs);
  log.transports.file.resolvePathFn = () => join(paths.logs, 'main.log');
} else {
  disableAllLogTransports();
}
log.info('=== steam-client main starting ===');

const isDev = !!process.env['ELECTRON_RENDERER_URL'];
const fakeRedeem = process.env.FAKE_REDEEM === '1';

// Resolved at app boot; mutated only when onFeatureFlagsChange fires (today
// that never happens — but the plumbing is in place for the future server
// poller). Synchronously readable from IPC handlers and module-level guards.
let featureFlags: FeatureFlags = { balanceEnabled: true };

/**
 * 1 completed task → +1 hour of game time. We earn locally first as an
 * optimistic update so the UI updates instantly; PATCH /tasks/{id}
 * status=completed asks the backend to credit the authoritative balance,
 * and a follow-up GET /users/{id}/balance + reconcileWithServer overwrites
 * the local sum once the round-trip completes. When `balanceEnabled` is
 * off (server flag), behaviour collapses to local-only.
 */
const TASK_REWARD_SECONDS = 3600;

// Single the API client. Bearer lives in safeStorage when available, else RAM.
const api = new ApiClient({
  baseUrl: apiBaseUrl(),
  timeoutMs: Number(process.env.API_TIMEOUT_MS || 15000),
  tokenFilePath: paths.authToken,
  fakeRedeem,
});
// The client wipes its Bearer on any 401 and says so. Nothing used to listen,
// so a revoked token left the app looking signed in while every call failed.
// Now it drops the remembered session too and routes back to the code screen.
api.on('auth:expired', () => {
  clearStoredUser(paths.authUser);
  if (session.state === 'signed_in') {
    log.info('[session] Bearer expired — signing out');
    library = [];
    setSession({ state: 'signed_out' });
  }
});
configureVault((id) => api.getAccount(id));
configureEmailAuthCodes((id, opts) => api.getEmailAuthCodes(id, opts));
configureFeatureFlags(api);

// Force-disable VAAPI codecs — libva on some Linux setups (notably VMs without
// GPU passthrough) keeps retrying initialization even with disableHardwareAcceleration,
// and the resulting fault can propagate up the systemd scope and kill the entire
// process tree silently.
app.commandLine.appendSwitch('disable-features', 'VaapiVideoDecoder,VaapiVideoEncoder');
app.commandLine.appendSwitch('disable-software-rasterizer');

// Disable HTTP/3 (QUIC) for Chromium's net stack. electron-updater fetches
// the feed via Electron's `net` module (Chromium), which tries QUIC over
// UDP 443 when the server advertises the h3 Alt-Svc. On networks where UDP
// 443 is dropped (e.g. behind certain VPN/tunnel setups) the QUIC attempt
// hangs ~40s and fails with ERR_CONNECTION_CLOSED instead of falling back to
// TCP — silently breaking auto-update. TCP h1/h2 works everywhere; the app's
// own API traffic goes through Node (never QUIC) and is unaffected.
app.commandLine.appendSwitch('disable-quic');

// Software rendering — libva/vaapi GPU init fails silently on some Linux setups
// (notably Zorin/XFCE VMs without GPU passthrough), killing the process.
// Must be called before app.ready, before any window creation.
app.disableHardwareAcceleration();

// ── Crash diagnostics ────────────────────────────────────────────────────
// electron-log may buffer the last few writes when the process exits abruptly,
// so we also append synchronously to a dedicated file in userData.
process.on('uncaughtException', (err) => {
  log.error('[main-crash] uncaughtException', { message: err.message, stack: err.stack });
  try {
    appendFileSync(
      join(app.getPath('userData') || '/tmp', 'main-crash.log'),
      `[${new Date().toISOString()}] uncaughtException: ${err.stack || err.message}\n`
    );
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  const formatted = formatRejection(reason);
  log.error('[main-crash] unhandledRejection', formatted);
  try {
    appendFileSync(
      join(app.getPath('userData') || '/tmp', 'main-crash.log'),
      `[${new Date().toISOString()}] unhandledRejection: ${formatted}\n`
    );
  } catch {}
});

/**
 * Build a human-readable one-liner from an arbitrary promise-rejection
 * reason. `String(reason)` on a plain object yields "[object Object]"
 * which hides the actual failure — for instance the steam-user logon
 * throw carries `tokenAudiences` on a bare Error and the default
 * stringifier drops it. We special-case the audience field (it's the
 * one we hit in practice — refresh tokens minted for web/mobile but
 * lacking the `client` audience required by the CM) and fall back to
 * Error.message + JSON dump of own properties for anything else.
 */
function formatRejection(reason: unknown): string {
  if (reason instanceof Error) {
    const extra = Object.getOwnPropertyNames(reason)
      .filter((k) => k !== 'message' && k !== 'stack' && k !== 'name')
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = (reason as unknown as Record<string, unknown>)[k];
        return acc;
      }, {});
    if (Array.isArray(extra['tokenAudiences'])) {
      const auds = (extra['tokenAudiences'] as unknown[]).join(',');
      return `${reason.message} [tokenAudiences=${auds}] — refresh token lacks 'client' audience; cannot be used to log into the Steam CM`;
    }
    const extraStr = Object.keys(extra).length
      ? ' ' + JSON.stringify(extra)
      : '';
    return `${reason.name}: ${reason.message}${extraStr}`;
  }
  if (reason && typeof reason === 'object') {
    try {
      return JSON.stringify(reason);
    } catch {
      return String(reason);
    }
  }
  return String(reason);
}

// Catch GPU / utility / zygote process deaths — render-process-gone only
// catches renderer crashes, leaving GPU subprocess deaths invisible.
app.on('child-process-gone', (_event, details) => {
  log.error('[main-crash] child-process-gone', {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    serviceName: details.serviceName,
    name: details.name,
  });
});

// Distinguish graceful shutdown from crash.
app.on('before-quit', () => {
  log.warn('[main-crash] before-quit fired');
});
app.on('will-quit', () => {
  log.warn('[main-crash] will-quit fired');
});

// Single-instance lock. requestSingleInstanceLock() on the secondary
// triggers the primary's 'second-instance' event (handler below) which
// surfaces the existing window. The secondary must then exit cleanly so
// it doesn't double-init paths, ledger, or the local IPC server.
if (!app.requestSingleInstanceLock()) {
  log.info('[startup] another instance owns the lock — handing off to it and exiting');
  app.exit(0);
}

ensurePaths();
initLedger();
// Steam Store appdetails survive restarts on disk — a fresh boot labels
// the catalog with genres without re-asking Steam for the whole library.
configureStoreDiskCache(join(paths.cache, 'steam-store-cache.json'));
// Self-heal Windows ACL AFTER the SQLite DB is open. Older builds hardened
// the tree with explicit (OI)(CI)F ACEs which sometimes left files in a
// state where the next launch could not re-open them, requiring a manual
// `icacls /reset /T` + `Remove-Item -Recurse`. We no longer harden; we just
// reset the whole config subtree to inherit on every boot, so any prior
// breakage heals itself silently. Fire-and-forget — never blocks startup.
if (process.platform === 'win32') {
  void selfHealWindowsAcl(paths.config).catch((err) => {
    log.warn('Windows ACL self-heal rejected', err);
  });
}
recoverOrphanedSessions();
// Adopt any on-disk installs the SQLite ledger doesn't know about yet
// (fresh client install over an existing %APPDATA% wipe, or a previous
// version that failed to persist the row). Must run after initLedger.
rescanInstallRoot();
installSecurity({ isDev });

// Fan out balance changes to WS (extension) and renderer IPC. A single
// subscription replaces ad-hoc pushWs calls scattered through tasks:complete
// and the enforcer tick. `balance:update` is the legacy channel carrying a
// bare number; `balance:changed` is the richer event with source so the
// renderer can tell server-confirmed reconciles apart from local mutations.
onBalanceChange((seconds) => {
  sendToRenderer('balance:update', seconds);
  sendToRenderer('balance:changed', { seconds, source: 'local' });
  pushWs({ type: 'balance', seconds });
});

// Wire the ledger's server-side balance reader to the the API client.
// `isEnabled()` is checked per-call so feature-flag flips at runtime take
// effect without re-wiring.
configureBalanceSync({
  api: {
    getUserBalance: (uid) => api.getUserBalance(uid),
  },
  getUserId: () => currentUser?.id ?? null,
  isEnabled: () => featureFlags.balanceEnabled,
  onServerBalance: (balance) => {
    sendToRenderer('balance:changed', { seconds: balance, source: 'server' });
  },
});

// Tracks whether we're tearing down for real. The tray "Quit" item flips
// this before app.quit(); the close-to-tray hook below leaves it false so
// clicking the X just hides the window.
app.isQuitting = false;

let mainWindow: BrowserWindow | null = null;
let tray: import('electron').Tray | null = null;
let library: PublicAccount[] = [];
/**
 * appid → account_id the current user was handed for that game.
 * Populated when the user clicks Play (we fetch /accounts/{id} and log
 * the mapping). Required by POST /metrics/games — server uses it to
 * decide which pool account's lock to hold based on our heartbeat.
 */
const accountByAppid = new Map<number, string>();

// ── Download queue ───────────────────────────────────────────────────────
// vault.withAccount allows only ONE pool-account session at a time (a
// security invariant: at most one plaintext-credential blob in memory), so
// DepotDownloader runs one download at a time. Extra download:start requests
// queue here and start automatically when the active one finishes, instead
// of failing with "another account session is still in flight".
interface QueuedDownload {
  accountId: string;
  appid: number;
  gameName: string;
  userId: string;
}
const downloadQueue: QueuedDownload[] = [];
let activeDownloadAppid: number | null = null;
// The item backing the active download, kept so a stall-kill can transparently
// re-run DepotDownloader (which resumes from the partial tree on disk) rather
// than surfacing the interruption as a failure. Only set for real user
// downloads via beginDownload — the launch-time update check never sets it, so
// an update check is never auto-resumed.
let activeDownloadItem: QueuedDownload | null = null;

// ── Auto-resume on stall ──────────────────────────────────────────────────
// A flaky/blocked connection can stall a large download long enough to trip
// DepotDownloader's stall watchdog. Instead of giving up (leaving a partial
// tree), we restart DD — which resumes via chunk validation — and keep going
// as long as each cycle makes forward progress, stopping after a few
// CONSECUTIVE no-progress stalls so a genuinely stuck download still surfaces.
const STALL_RESUME_MAX_NO_PROGRESS = 3;
const STALL_RESUME_BACKOFF_MS = 5_000;
const STALL_RESUME_PROGRESS_BYTES = 8 * 1024 * 1024; // 8 MB
/** Latest cumulative bytes-on-disk seen per appid (from progress events). */
const lastDownloadBytes = new Map<number, number>();
/** Bytes-on-disk at the previous stall, to tell if a resume cycle progressed. */
const bytesAtLastStall = new Map<number, number>();
/** Consecutive no-progress stall count per appid. */
const stallNoProgress = new Map<number, number>();
/** Appids with an auto-resume already scheduled — dedupes the two terminal
 *  events DD emits per run (proc `close` + driver `.catch`) so we resume once. */
const resumePending = new Set<number>();

function clearStallState(appid: number): void {
  lastDownloadBytes.delete(appid);
  bytesAtLastStall.delete(appid);
  stallNoProgress.delete(appid);
  resumePending.delete(appid);
}

/** The one download-progress listener — updates the cache, forwards to the
 *  renderer/WS, transparently resumes stalled downloads, and advances the
 *  queue when the active download really finishes. */
function downloadProgressListener(p: DownloadProgress): void {
  if (typeof p.bytesDownloaded === 'number') {
    lastDownloadBytes.set(p.appid, p.bytesDownloaded);
  }

  // Transparent stall recovery: intercept a stall-kill on the active real
  // download before it reaches the UI as a failure, and re-run DD (which
  // resumes from disk) after a short backoff. Give up only after repeated
  // stalls that made no forward progress.
  if (
    p.done &&
    p.error === 'stall_timeout' &&
    p.appid === activeDownloadAppid &&
    activeDownloadItem?.appid === p.appid
  ) {
    if (resumePending.has(p.appid)) return; // dedupe DD's double terminal event
    const cur = lastDownloadBytes.get(p.appid) ?? 0;
    const prev = bytesAtLastStall.get(p.appid) ?? 0;
    const madeProgress = cur > prev + STALL_RESUME_PROGRESS_BYTES;
    const consec = madeProgress ? 0 : (stallNoProgress.get(p.appid) ?? 0) + 1;
    stallNoProgress.set(p.appid, consec);
    bytesAtLastStall.set(p.appid, cur);
    if (consec <= STALL_RESUME_MAX_NO_PROGRESS) {
      const item = activeDownloadItem;
      resumePending.add(p.appid);
      log.info('[download] stall — auto-resuming', {
        appid: p.appid,
        consecNoProgress: consec,
        bytes: cur,
      });
      // Show a reconnecting state instead of a failure.
      const retry: DownloadProgress = {
        appid: p.appid,
        percent: p.percent,
        done: false,
        stage: { phase: 'connecting' },
      };
      library = applyDownloadProgress(library, retry);
      sendToRenderer('download:progress', retry);
      // activeDownloadAppid stays set so nothing else dequeues; the backoff
      // also lets the dead DD's vault session fully release before re-acquire.
      setTimeout(() => {
        if (activeDownloadAppid === p.appid && activeDownloadItem === item) {
          resumePending.delete(p.appid);
          beginDownload(item);
        }
      }, STALL_RESUME_BACKOFF_MS);
      return; // swallow the terminal event
    }
    log.warn('[download] stall — resume budget exhausted, giving up', {
      appid: p.appid,
    });
    // fall through: report the failure and advance the queue.
  }

  library = applyDownloadProgress(library, p);
  sendToRenderer('download:progress', p);
  pushWs({ type: 'download', appid: p.appid, percent: p.percent, done: p.done });
  if (p.done && p.appid === activeDownloadAppid) {
    activeDownloadAppid = null;
    activeDownloadItem = null;
    clearStallState(p.appid);
    // Defer to a macrotask so the finished download's vault session (whose
    // release runs in a `finally` microtask after this synchronous emit)
    // is freed before the next download tries to acquire a different
    // account — otherwise withAccount would throw "another account session
    // is still in flight".
    setImmediate(() => processDownloadQueue());
  }
}

function beginDownload(item: QueuedDownload): void {
  activeDownloadAppid = item.appid;
  activeDownloadItem = item;
  accountByAppid.set(item.appid, item.accountId);
  // Drop any warm steam-user session before DD starts — two concurrent
  // Steam sessions on the same account trigger RateLimitExceeded.
  logOffSteam();
  log.info('[download] starting', { appid: item.appid });
  void startDownload(
    item.accountId,
    item.appid,
    item.gameName,
    downloadProgressListener,
    item.userId,
    { language: steamLanguage() }
  ).catch((err) => {
    log.warn('[download] start failed', {
      appid: item.appid,
      err: (err as Error).message,
    });
    // Surface as a terminal error and advance the queue.
    downloadProgressListener({
      appid: item.appid,
      percent: 0,
      done: true,
      error: (err as Error).message,
    });
  });
}

/** Start the next queued download if nothing is currently active. */
function processDownloadQueue(): void {
  if (activeDownloadAppid !== null) return;
  const next = downloadQueue.shift();
  if (next) beginDownload(next);
}

/**
 * appids whose start is in flight — claimed synchronously on entry to the
 * download/launch handler and released when it returns.
 *
 * `isQueuedOrActive` cannot cover this: the queue slot is only claimed at the
 * very end of the handler, and everything in between (the session gate, the
 * store pre-flight) is awaited. The gate is a network round-trip on every
 * click now, so without this a double-click reliably passes the guard twice
 * and queues the same game a second time — which the queue drain then
 * happily downloads all over again.
 */
const startsInFlight = new Set<number>();

/** appid is downloading now, queued, or has a live DD process. */
function isQueuedOrActive(appid: number): boolean {
  return (
    activeDownloadAppid === appid ||
    downloadQueue.some((q) => q.appid === appid) ||
    isDownloading(appid)
  );
}

// ── Session (driven by the API redeem flow) ──────────────────────────────────
let session: SessionStatus = { state: 'signed_out' };
let currentUser: UserRead | null = null;

/**
 * Pick the session back up from what was persisted at redeem time.
 *
 * The Bearer does not expire and is already on disk; the only reason a
 * restart used to cost a code is that nothing ever put the two together. The
 * cached user record is trusted immediately rather than confirmed first, so
 * the library is there the moment the window is — waiting on `/users/me`
 * would mean a spinner on every launch and a code screen on every flaky
 * connection, with a perfectly good token sitting right there.
 *
 * The server still gets the last word, just not on the critical path: the
 * refresh below picks up a changed trust level, and a Bearer that has been
 * revoked comes back 401, which signs the user out for real. Everything that
 * matters — installing, launching — is gated on a live check anyway, so an
 * optimistic restore cannot hand out access the server would refuse.
 *
 * Deliberately does NOT re-seed local metrics: `seedLocalFromServer` clears
 * the local tables, which is right for a fresh sign-in and would throw away
 * unflushed playtime here.
 */
function restoreSession(): void {
  if (fakeRedeem || !api.hasToken()) return;
  const stored = loadStoredUser(paths.authUser);
  if (!stored) return;
  log.info('[session] restored from disk', { userId: stored.id });
  setSession({ state: 'signed_in', user: stored });

  // `/users/me` is the natural call but has never had a caller in this app,
  // so it is not a proven endpoint; `/users/{id}` is used all over. Try the
  // former and fall back rather than let an unimplemented route look like a
  // dead session.
  void api
    .getMe()
    .catch(() => api.getUser(stored.id))
    .then((fresh) => {
      // Only touch the session if we are still the one that restored it —
      // a sign-out or a redeem may have landed while this was in flight.
      if (session.state !== 'signed_in' || session.user.id !== stored.id) return;
      saveStoredUser(paths.authUser, fresh);
      setSession({ state: 'signed_in', user: fresh });
    })
    .catch((err) => {
      // A 401 has already wiped the Bearer inside the client, and the
      // auth:expired subscriber above turns that into a sign-out — nothing
      // to do here but say why. Anything else means we could not reach the
      // server: the token is still good as far as we know, so the user stays
      // signed in and the gate refuses whatever actually needs the network.
      log.warn('[session] refresh failed', { err: (err as Error).message });
    });
}

function setSession(next: SessionStatus): void {
  session = next;
  if (next.state === 'signed_in') {
    currentUser = next.user;
    startMetricsFlush({
      api,
      getUserId: () => currentUser?.id ?? null,
      getLibrary: () => library,
      getAccountIdForApp: (appid) => accountByAppid.get(appid) ?? null,
      intervalMs: Number(process.env.METRICS_FLUSH_INTERVAL_MS || 60_000),
    });
  } else if (next.state === 'signed_out') {
    currentUser = null;
    accountByAppid.clear();
    stopMetricsFlush();
  }
  sendToRenderer('auth:status', next);
}

app.setAsDefaultProtocolClient('steam-client');

function createWindow(): void {
  log.info('[boot] before createWindow');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0a0c10',
    hasShadow: true,
    webPreferences: {
      // CJS preload enables sandbox:true. The only globals exposed into the
      // renderer are the contextBridge entries defined in preload/index.ts.
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  log.info('[boot] window created, before loadURL');

  mainWindow.once('ready-to-show', () => {
    log.info('[boot] window ready-to-show');
    mainWindow?.show();
  });

  // Close-to-tray: when the user clicks X (titlebar custom or OS-decorated),
  // hide the window instead of destroying it — but only if a tray was
  // successfully created. Without a tray, hiding leaves the user with no
  // way to bring the app back, so we let the close fall through.
  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;
    if (!tray) return;
    e.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log.error('[recovery] render process gone', { reason: details.reason, exitCode: details.exitCode });
    if (details.reason === 'killed' || details.reason === 'integrity-failure') {
      log.warn('[recovery] not auto-reloading, terminal reason');
      return;
    }
    log.info('[recovery] reloading window after renderer crash');
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.reload();
      }
    }, 250);
  });

  mainWindow.webContents.on('unresponsive', () => {
    log.warn('[recovery] renderer unresponsive — keeping alive');
  });

  mainWindow.webContents.on('responsive', () => {
    log.info('[recovery] renderer back to responsive');
  });

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow
      .loadURL(process.env['ELECTRON_RENDERER_URL'])
      .then(() => log.info('[boot] loadURL resolved'))
      .catch((err) => log.error('[boot] loadURL failed:', (err as Error).message));
  } else {
    mainWindow
      .loadFile(join(import.meta.dirname, '../renderer/index.html'))
      .then(() => log.info('[boot] loadFile resolved'))
      .catch((err) => log.error('[boot] loadFile failed:', (err as Error).message));
  }
}

function sendToRenderer(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function flushDeeplink(): void {
  const code = takePendingCode();
  if (code) sendToRenderer('deeplink:redeem', { code });
}

/**
 * True when the install tree contains a steam_api*.dll — i.e. the game
 * links the Steamworks API and needs gbe_fork + ColdClientLoader. Titles
 * without one (e.g. Republic Commando, a pre-Steamworks title that only
 * wants the SteamAppId env var) must spawn DIRECTLY: routing them through
 * the loader's steamclient injection makes them bail with
 * "Failed to find steam".
 */
function hasSteamApiDll(dir: string, depth = 0): boolean {
  if (depth > 6) return false;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && /^steam_api(64)?\.dll$/i.test(e.name)) return true;
    if (e.isDirectory() && !e.name.startsWith('.')) {
      if (hasSteamApiDll(join(dir, e.name), depth + 1)) return true;
    }
  }
  return false;
}

/**
 * True when the install carries a `steam_api*.dll.gbe_fork` marker — i.e.
 * it was patched via the dual-arch swap flow (which replaces Valve's
 * steam_api with gbe_fork). Games patched this way (e.g. Coffee Talk, a
 * Unity/Steamworks.NET title) must STAY on the swap flow: the arch-known
 * "keep Valve + experimental steamclient" path doesn't work for them (the
 * game crashes on SteamAPI_Init right after the splash). Detecting the
 * marker keeps the launch mode consistent with how the game was installed,
 * regardless of whether exe-arch detection later flips to arch-known.
 */
function hasGbeForkMarker(dir: string, depth = 0): boolean {
  if (depth > 6) return false;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && /^steam_api(64)?\.dll\.gbe_fork$/i.test(e.name)) return true;
    if (e.isDirectory() && !e.name.startsWith('.')) {
      if (hasGbeForkMarker(join(dir, e.name), depth + 1)) return true;
    }
  }
  return false;
}

async function launchGame(appid: number): Promise<{ ok: true } | { ok: false; error: string }> {
  // Resolve the install dir from the ledger (filled in by the downloader on
  // a successful install) and fall back to `installPathFor` which mirrors
  // DD's output convention. After DD has just been re-run with `-validate`
  // for the update check, the dir is guaranteed to exist on disk.
  const ledgerRow = getInstall(appid);
  let installDir = ledgerRow?.path || installPathFor(appid);
  let exePath!: string;
  let exeArch: ExeArch | null = null;
  let authoritative: 'appinfo' | 'heuristic' = 'heuristic';
  try {
    // Authoritative path: `appinfo.vdf` (PICS productInfo) carries the
    // exact launch exe and arch the publisher intends. This is critical
    // for games whose install layout doesn't put the launch exe in the
    // install root (UE shipping binaries in `Binaries/Win64/`, games
    // with a separate launcher wrapper like Republic Commando's
    // `LaunchRC.exe`, etc.) — `findGameExe` below is a heuristic that
    // can't reliably tell those apart. appinfo is fetched from a PICS
    // round-trip, so it's not always available (e.g. signed-out before
    // the first PICS handshake); in that case we silently fall through
    // to the heuristic. The cache makes repeat launches cheap.
    const launchInfo = await defaultSteamAppInfoService().getLaunchInfo(appid);
    let appinfoExe: string | null = null;
    if (launchInfo) {
      const normalized = launchInfo.launchExe.replace(/\\/g, sep);
      // Resolve the appinfo launchExe against OUR install dir
      // (<installRoot>/<appid>), NOT appinfo's steamapps/common/<installdir>
      // name — our games don't live in Steam's library layout, so joining
      // on appinfo's installdir produced a relative path that never existed
      // on disk and silently fell through to the heuristic.
      appinfoExe = join(installDir, normalized);
      if (existsSync(appinfoExe)) {
        exePath = appinfoExe;
        // `arch` is null when Valve's launch entry omits osarch (old
        // titles) — PE-detect the real bitness from the resolved exe.
        exeArch = launchInfo.arch ?? detectExeArch(appinfoExe);
        authoritative = 'appinfo';
        log.info('[launch] exe resolved from appinfo.vdf', {
          appid,
          launchExe: launchInfo.launchExe,
          arch: exeArch,
        });
      } else {
        log.warn(
          '[launch] appinfo.vdf launchExe not on disk; falling back to heuristic',
          { appid, appinfoExe, installDir }
        );
      }
    }
    if (!appinfoExe || !existsSync(appinfoExe)) {
      const found = findGameExe(installDir, ledgerRow?.name);
      // Heuristic fallback for when appinfo.vdf is unavailable (e.g. signed
      // out before the first PICS handshake). findGameExe ranks candidates
      // by name match / arch / stub-likelihood and returns its best guess;
      // we do NOT second-guess it by rerouting to a launcher — the whole
      // point is to honour the publisher's real launch exe.
      exePath = found.path;
      exeArch = detectExeArch(exePath);
      log.info('[launch] exe resolved', {
        appid,
        installDir,
        chosen: found.path,
        reason: found.reason,
        arch: exeArch,
        candidates: found.candidates.map((c) => ({
          path: c.path,
          size: c.size,
          depth: c.depth,
          ue: c.ueVariant,
          stub: c.isLikelyStub,
          nameScore: c.nameScore,
          steamAppid: c.siblingsHaveSteamAppid,
          steamApiDll: c.siblingsHaveSteamApiDll,
        })),
      });
    }
    void authoritative;
  } catch (err) {
    log.error('[launch] cannot locate game executable', {
      appid,
      installDir,
      err: (err as Error).message,
    });
    return { ok: false, error: (err as Error).message };
  }
  // Self-heal: an install from before the DRM-patch pipeline landed (or one
  // skipped because the launch hit the update-check cache and never re-ran
  // DD) still carries Valve's stock steam_api*.dll and an exe with the
  // SteamStub wrapper — spawn would just trigger Steam. We block here on
  // the patcher, but only when at least one DLL is missing its .gbe_fork
  // marker OR the per-install ColdClientLoader pieces are missing next to
  // the main exe (catches trees patched before the loader integration
  // landed — they carry markers but lack the loader, so direct spawn
  // would fall back to Steam-required mode). Passing exePath lets
  // needsDrmPatching probe the main-exe-adjacent loader/ini/steamclient
  // dropoffs that sections 4 & 5 of applyDrmPatches own. Cost on the
  // happy path is one directory walk plus three existsSync calls.
  //
  // `arch` switches the patcher into the arch-known flow when we can
  // confidently identify the exe's bitness from its PE header. The
  // arch-known path skips ColdClientLoader entirely (which is x64-only —
  // it bails with "Arch of loader and requested exe are different" on a
  // 32-bit target) and instead drops the matching-arch gbe_fork
  // `steam_api*.dll` + `steamclient*.dll` pair next to the main exe,
  // letting the game load them via Windows' default DLL search order.
  // Without `arch`, the patcher falls back to dropping BOTH bitness DLLs
  // and the x64 ColdClientLoader — fine for dual-arch games like Arma
  // III that ship both 32- and 64-bit exes, fatal for pure-x86 titles
  // such as Conflict: Desert Storm and Postal Plus. arm64 is currently
  // unsupported (we ship x86/x64 vendor DLLs only) so we treat it as
  // "unknown" and stay on the legacy path — the user gets a clear error
  // if they actually try to launch instead of a silent crash.
  // Stay on the dual-arch swap flow if this install was already patched
  // that way (steam_api.dll.gbe_fork marker present). Some Steamworks
  // titles — notably Unity/Steamworks.NET ones like Coffee Talk — only work
  // with the gbe_fork swap and crash under the arch-known experimental
  // path; keeping the mode consistent with the original patch avoids
  // flipping them to a path that breaks them just because exe-arch
  // detection now succeeds.
  const wasSwapPatched = hasGbeForkMarker(installDir);
  // Only 32-bit titles take the experimental steamclient path. That path
  // keeps Valve's steam_api and relies on ColdClientLoader injecting the
  // Steam IPC environment into the launched process — which silently breaks
  // when the launch exe is a thin launcher that spawns the REAL game as a
  // CHILD process (UE titles: Tropico6.exe → …/Tropico6-Win64-Shipping.exe).
  // The child never inherits the loader's environment, so its steam_api
  // loads the experimental steamclient bare and recurses into a stack
  // overflow (the "UE4-Tropico6 / EXCEPTION_STACK_OVERFLOW" crash). The
  // regular gbe_fork swap is self-contained (no steamclient/loader
  // dependency) and works in any process that loads it, child or not, so
  // 64-bit titles always use it. The old x86 natives (Postal Plus, Conflict:
  // Desert Storm) genuinely need the experimental path — they abort with
  // "Can't initialize Steamworks" under the regular swap — so they keep it.
  const patchArch: 'x86' | 'x64' | null =
    wasSwapPatched
      ? null
      : exeArch === 'x86'
        ? 'x86'
        : null;
  const patchOpts = patchArch ? { arch: patchArch } : {};
  if (needsDrmPatching(installDir, exePath, patchOpts)) {
    log.info('[launch] DRM patches missing — applying before spawn', {
      appid,
      installDir,
      arch: exeArch,
    });
    sendToRenderer('game:launchProgress', {
      appid,
      phase: 'patching',
      percent: 0,
    });
    let drmFailureReason: string | null = null;
    try {
      await applyDrmPatches(installDir, appid, exePath, patchOpts);
      // Even on a clean return the per-DLL copyFileSync may have failed
      // silently (logged, never thrown). Re-probe the markers — if any
      // DLL still lacks one, surface the Steam-required warning anyway.
      if (needsDrmPatching(installDir, exePath, patchOpts)) {
        drmFailureReason = 'partial_patch';
      }
    } catch (err) {
      // Non-fatal: let the user launch a partially-patched build. The
      // toast below tells them Steam may need to be running.
      log.warn('[launch] DRM patcher threw — launching anyway', {
        appid,
        err: (err as Error).message,
      });
      drmFailureReason = (err as Error).message;
    }
    if (drmFailureReason) {
      log.warn('[launch] DRM patch incomplete', {
        appid,
        reason: drmFailureReason,
      });
      sendToRenderer('game:drm_warning', {
        appid,
        reason: drmFailureReason,
      });
    }
  }
  // Tracking is telemetry, not a gate. Refusing to launch because the
  // stopwatch is busy would turn a mis-latched process into "this launcher
  // cannot start any game until you restart it" — and before playtime
  // tracking ran for everyone, this path could not be reached at all with
  // the balance off. Only a second copy of the SAME game is refused.
  if (getEnforcingAppid() === appid) {
    return { ok: false, error: 'already_running' };
  }
  const tracked = await startEnforcing(appid, processNamesForExe(exePath));
  if (!tracked) {
    log.info('[launch] another game is being tracked; launching untracked', {
      appid,
      tracking: getEnforcingAppid(),
    });
  }
  // Spawn the game directly. The locally-installed Steam client will
  // detect the running process and provide overlay / cloud-save / etc.
  // We deliberately skip `steam://run/<appid>` because that path also
  // forces Steam to refresh ownership against Valve's servers — pointless
  // when the depot is already on disk and the local user is signed in,
  // and historically the cause of the redundant pool-account login that
  // crashed on refresh tokens lacking the `client` audience.
  try {
    // SteamAPI_RestartAppIfNecessary looks for steam_appid.txt in the
     // process CWD, not next to the .exe. If the CWD is the install root
     // but the .exe (and its appid file) lives in FG/Binaries/Win64, the
     // game won't find the flag and will relaunch itself via steam://.
     // Spawn with cwd = exe's directory so the appid file is in scope.
    //
    // If the DRM patcher dropped ColdClientLoader next to the exe (it
    // does whenever vendor ships the loader), spawn the loader instead.
    // gbe_fork's experimental steamclient64.dll — which we copy next to
    // the exe for games that LoadLibrary("steamclient64.dll") directly —
    // fails `SteamAPI_Init` with "Unable to initialize SteamAPI. Please
    // make sure Steam is running" unless its host process was launched
    // by ColdClientLoader, because the loader is what sets up the IPC
    // environment the dll expects from a real `steam.exe`. The loader
    // reads ColdClientLoader.ini (also written by the patcher) and
    // execs the game exe itself, so we still get the right child but
    // with SteamAPI initialised.
    //
    // ColdClientLoader is shipped as `steamclient_loader_x64.exe` — a
    // 64-bit-only build. Spawning it on a 32-bit main exe fails
    // ColdClientLoader ships as two binaries (`steamclient_loader_x64.exe`
    // and `steamclient_loader_x86.exe`); spawning the matching-arch one
    // is non-negotiable. The legacy flow dropped only the x64 build; the
    // drm-patcher now drops both in dual-arch mode and only the matching
    // one in arch-known mode. Pick the matching loader when we know the
    // exe's arch, otherwise prefer x64 (preserves the historical
    // behaviour for installs where arch detection couldn't make a call).
    const exeDir = dirname(exePath);
    const loaderX64 = join(exeDir, 'steamclient_loader_x64.exe');
    const loaderX86 = join(exeDir, 'steamclient_loader_x86.exe');
    let launcherExe: string | null = null;
    if (exeArch === 'x86' && existsSync(loaderX86)) {
      launcherExe = loaderX86;
    } else if (exeArch !== 'x86' && existsSync(loaderX64)) {
      launcherExe = loaderX64;
    } else if (exeArch === 'x86' && existsSync(loaderX64)) {
      // Legacy install dropped only the x64 loader before the arch-aware
      // flow landed. Spawning it on an x86 exe bails with "Arch of loader
      // and requested exe are different" — surface a clear error instead
      // of silently failing.
      log.error(
        '[launch] main exe is x86 but only the x64 ColdClientLoader is present',
        { mainExe: exePath, loaderX64 }
      );
      if (tracked) stopEnforcing('launch_failed');
      return {
        ok: false,
        error: 'cold_client_loader_arch_mismatch',
      };
    } else if (existsSync(loaderX64)) {
      launcherExe = loaderX64;
    } else if (existsSync(loaderX86)) {
      launcherExe = loaderX86;
    }
    // A game with no steam_api*.dll doesn't use the Steamworks API — it
    // only needs SteamAppId set (Steam convention). Such a title (e.g.
    // Republic Commando) must NOT go through ColdClientLoader: gbe_fork's
    // steamclient injection makes it bail with "Failed to find steam".
    // Spawn it directly with the env var instead. Games that DO link
    // steam_api still need the loader for SteamAPI_Init.
    const usesSteamworks = hasSteamApiDll(installDir);
    const useLoader = usesSteamworks && launcherExe !== null;
    // Defensive: if gbe_fork has already been applied to this install
    // (steamclient*.dll sits next to the main exe), the bare exe WILL
    // fail SteamAPI_Init — gbe_fork's experimental steamclient stub
    // refuses to load outside a ColdClientLoader-spawned process because
    // the IPC pipes / env the dll expects only exist in that context.
    // The historical "fall back to direct spawn" silently produced two
    // failure modes the user can't tell apart:
    //   - bare exe exits immediately with "Unable to initialize
    //     SteamAPI" (looks like a clean no-op)
    //   - bare exe with intact SteamStub calls steam://run/<appid>, real
    //     Steam relaunches it, the cycle repeats until killed manually
    // Refuse to launch and surface a clear error instead. The check is
    // gated on the matching-arch steamclient*.dll because that's what
    // the running exe will LoadLibrary — its presence implies a loader
    // is required to satisfy SteamAPI_Init. Only meaningful for Steamworks
    // titles: a non-Steamworks game's stray steamclient.dll (dropped by the
    // patcher) is irrelevant since it never LoadLibrary's it.
    const matchingSteamclient =
      exeArch === 'x86'
        ? join(exeDir, 'steamclient.dll')
        : join(exeDir, 'steamclient64.dll');
    const gbeForkApplied = existsSync(matchingSteamclient);
    if (usesSteamworks && gbeForkApplied && !useLoader) {
      log.error(
        '[launch] gbe_fork is patched in but ColdClientLoader is missing — refusing to spawn bare exe (would fail SteamAPI_Init or trigger steam:// re-launch loop)',
        { installDir: exeDir, mainExe: exePath, arch: exeArch }
      );
      if (tracked) stopEnforcing('launch_failed');
      return {
        ok: false,
        error: 'cold_client_loader_missing',
      };
    }
    const spawnExe: string = useLoader ? (launcherExe as string) : exePath;
    log.info('[launch]', {
      mode: useLoader ? 'cold-client-loader' : 'direct',
      spawnExe,
      mainExe: exePath,
    });
    const child = spawn(spawnExe, [], {
      detached: true,
      stdio: 'ignore',
      cwd: dirname(exePath),
      windowsHide: false,
      // Steam games read SteamAppId/SteamGameId from the environment to
      // identify themselves; a pre-Steamworks title like Republic Commando
      // exits immediately without it. ColdClientLoader sets these itself
      // for the games it hosts, but a direct spawn must supply them.
      env: {
        ...process.env,
        SteamAppId: String(appid),
        SteamGameId: String(appid),
      },
    });
    child.on('error', (err) => {
      log.error('[launch] spawn error', { spawnExe, message: err.message });
    });
    child.unref();
    if (tracked && !useLoader) adoptSpawnedPid(appid, child.pid);
    log.info('[launch] spawned', { appid, spawnExe, mainExe: exePath, pid: child.pid });
  } catch (err) {
    if (tracked) stopEnforcing('launch_failed');
    log.error('[launch] spawn threw', { exePath, err: (err as Error).message });
    return { ok: false, error: (err as Error).message };
  }
  return { ok: true };
}

/**
 * Walk the install root and adopt any `<appid>` subdir that contains a
 * plausible game .exe but has no `installs` row (or a stale one pointing
 * elsewhere). Lets the user keep their state even after a DB wipe / fresh
 * client install, and recovers transparently if a previous version of the
 * client failed to persist the row.
 *
 * Called once on boot — name defaults to a placeholder; library:list will
 * replace it with the real `game_name` on first sign-in.
 */
function rescanInstallRoot(): void {
  let root: string;
  try {
    root = getInstallRoot();
  } catch {
    return;
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true }) as Dirent[];
  } catch (err) {
    log.debug('[rescan] install root not readable', {
      root,
      err: (err as Error).message,
    });
    return;
  }
  let adopted = 0;
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (!/^\d+$/.test(ent.name)) continue;
    const appid = Number(ent.name);
    if (!Number.isFinite(appid)) continue;
    const dir = join(root, ent.name);
    if (!hasGameExe(dir)) continue;
    // Don't adopt a half-downloaded tree as "installed" — an interrupted DD
    // run leaves full-size but zero-filled archives that pass hasGameExe.
    if (!isInstallComplete(dir)) continue;
    const existing = getInstall(appid);
    if (
      existing?.status === 'installed' &&
      existing.path === dir &&
      existing.name
    )
      continue;
    upsertInstall(appid, existing?.name ?? `app_${appid}`, 'installed', dir);
    adopted++;
  }
  if (adopted > 0) log.info(`[rescan] adopted ${adopted} on-disk install(s)`);
}

/**
 * Boot-time DRM patch sweep. Iterates every `installed` row in the ledger,
 * probes each tree for the `.gbe_fork` marker, and patches the ones that
 * predate the integration in commit 23b4db6 (or skipped patching because
 * the launch flow hit the update-check cache and never re-ran DD). Runs
 * async on the macro-tasks queue so it never blocks window creation; emits
 * `drm-boot:progress` / `drm-boot:done` so the renderer can show a toast.
 *
 * Idempotency is handled by needsDrmPatching — already-patched trees are
 * cheap to skip (one directory walk per game), so we can run this on
 * every boot.
 *
 * Failures don't bubble: applyDrmPatches is best-effort, and a single
 * broken install must not stop the queue from servicing the rest.
 */
function startBootDrmPatchScan(): void {
  const rows = listInstalls().filter((r) => r.status === 'installed');
  const queue: Array<{
    appid: number;
    name: string;
    dir: string;
    exePath: string | null;
    arch: ExeArch | null;
    // The mode-corrected arch (x64 → null = regular, per the launchGame
    // comment) that `needsDrmPatching` was gated on. `applyDrmPatches` MUST
    // use the same value: if the decision runs in regular mode but the patch
    // runs in arch-known mode, an x64 install patched the old experimental
    // way re-patches on every boot forever — needsDrmPatching(regular) keeps
    // seeing Valve's steam_api with no `.gbe_fork` marker, while
    // applyDrmPatches(arch-known) keeps Valve's DLL and never writes one.
    patchArch: 'x86' | 'x64' | null;
  }> = [];
  for (const r of rows) {
    const dir = r.path || installPathFor(r.appid);
    // Resolve the main exe up-front so needsDrmPatching can probe the
    // per-install ColdClientLoader files (loader/ini/steamclient64) that
    // live next to it — older installs predate the loader and have their
    // gbe_fork markers but no loader, so a dir-only probe would miss
    // them. Failed exe resolution falls back to the dll-marker-only path.
    //
    // PE-header sniff right after findGameExe so we can pass the bitness
    // into needsDrmPatching / applyDrmPatches. The arch-known flow
    // (ColdClientLoader skipped, only matching-arch gbe_fork DLLs
    // dropped) is the only viable setup for pure-x86 installs — the
    // legacy dual-arch path would drop steamclient_loader_x64.exe and
    // ColdClientLoader.ini next to the exe, then refuse to launch because
    // the x64 loader can't exec a 32-bit target.
    //
    // arm64 is preserved on the queue entry for logging but not passed
    // to the patcher (we ship x86/x64 vendor DLLs only).
    let exePath: string | null = null;
    let arch: ExeArch | null = null;
    try {
      exePath = findGameExe(dir, r.name).path;
      arch = detectExeArch(exePath);
    } catch {
      exePath = null;
      arch = null;
    }
    // Mirror the launch-time mode decision (see the patchArch comment in
    // launchGame): only x86 natives take the experimental steamclient path
    // — x64 titles use the self-contained regular swap, which survives a
    // launcher→child process split (the UE4-Tropico6 stack-overflow crash).
    // Trees already swapped in regular mode keep it (marker present).
    const wasSwapPatched = hasGbeForkMarker(dir);
    const patchArch: 'x86' | 'x64' | null =
      wasSwapPatched ? null : arch === 'x86' ? 'x86' : null;
    const patchOpts = patchArch ? { arch: patchArch } : {};
    try {
      if (!needsDrmPatching(dir, exePath ?? undefined, patchOpts)) continue;
    } catch (err) {
      log.warn('[drm-boot] needsDrmPatching threw', {
        appid: r.appid,
        err: (err as Error).message,
      });
      continue;
    }
    queue.push({ appid: r.appid, name: r.name, dir, exePath, arch, patchArch });
  }
  if (queue.length === 0) {
    log.info('[drm-boot] all installs already patched');
    return;
  }
  log.info('[drm-boot] scheduling boot patch sweep', { count: queue.length });
  // Notify renderer up-front so the toast can mount with the total.
  sendToRenderer('drm-boot:progress', {
    total: queue.length,
    current: 0,
    appid: null,
    name: null,
  });
  void (async () => {
    let processed = 0;
    for (const item of queue) {
      processed++;
      sendToRenderer('drm-boot:progress', {
        total: queue.length,
        current: processed,
        appid: item.appid,
        name: item.name,
      });
      log.info('[drm-boot] DRM-patching', item.appid, item.name);
      try {
        // applyDrmPatches uses mainExePath only to drop one of the two
        // steam_appid.txt copies (the other is dropped next to every
        // replaced DLL). On the no-exe path we fall back to the install
        // dir root so the main-exe copy still lands somewhere useful.
        //
        // Use item.patchArch — the SAME mode needsDrmPatching was gated on
        // above — NOT the raw exe arch. Passing the raw arch here re-opened
        // the every-boot re-patch loop for x64 experimental installs (see
        // the queue type comment). null keeps the self-contained regular
        // swap, which writes the marker that lets the next boot skip.
        await applyDrmPatches(
          item.dir,
          item.appid,
          item.exePath ?? join(item.dir, 'steam_appid.txt'),
          item.patchArch ? { arch: item.patchArch } : {}
        );
        log.info('[drm-boot] DRM-patched', item.appid, item.name, {
          arch: item.arch,
        });
      } catch (err) {
        log.warn('[drm-boot] patch failed', {
          appid: item.appid,
          err: (err as Error).message,
        });
      }
    }
    sendToRenderer('drm-boot:done', { total: queue.length });
  })().catch((err) => {
    log.warn('[drm-boot] sweep driver crashed', (err as Error).message);
  });
}

// ── Initial deeplink from argv ──────────────────────────────────────────
const initialDeep = extractDeeplinkFromArgv(process.argv);
if (initialDeep) {
  const code = parseDeeplink(initialDeep);
  if (code) setPendingCode(code);
}

app.on('second-instance', (_event, argv) => {
  log.info('[main] second-instance event');
  const url = extractDeeplinkFromArgv(argv);
  if (url) {
    const code = parseDeeplink(url);
    if (code) {
      setPendingCode(code);
      flushDeeplink();
    }
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Window may be hidden (close-to-tray), minimized, or just unfocused.
  // Cover all three so a second launch always brings it back to the
  // foreground instead of being a silent no-op.
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  // Brief alwaysOnTop flash defeats Windows' foreground-stealing
  // prevention — focus() alone can leave the window flashing in the
  // taskbar instead of coming to the front.
  mainWindow.setAlwaysOnTop(true);
  mainWindow.focus();
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(false);
    }
  }, 500);
});

// ── Dev stub for pool when FAKE_REDEEM=1 ─────────────────────────────
function devStubAccounts(userTrustLevel: number): PublicAccount[] {
  const fixtures: Array<
    Pick<PublicAccount, 'id' | 'appid' | 'game_name' | 'min_trust_level'>
  > = [
    { id: 'stub-1', appid: 413150, game_name: 'Stardew Valley', min_trust_level: 0 },
    { id: 'stub-2', appid: 1091500, game_name: 'Cyberpunk 2077', min_trust_level: 40 },
    { id: 'stub-3', appid: 252490, game_name: 'Rust', min_trust_level: 80 },
  ];
  return fixtures.map((f) => ({
    ...f,
    iconUrl: steamIconUrl(f.appid),
    logoUrl: steamLogoUrl(f.appid),
    locked: f.min_trust_level > userTrustLevel,
    status: 'not_installed',
    downloadPercent: null,
    downloadStage: null,
    guardHint: null,
    downloadError: null,
    downloadErrorPlatforms: null,
    downloadBytesDownloaded: null,
    downloadBytesTotal: null,
  }));
}

/**
 * Clear local state and hydrate it with whatever the server already knows
 * about this user. Called on sign-in; MUST complete before the metrics
 * flusher starts, otherwise we overwrite server totals with local zeros.
 *
 * Strategy:
 *   1. Wipe play_sessions, site_times, ledger (defensive: previous session
 *      data could belong to a different user on the same machine).
 *   2. Fetch all /metrics/games and /metrics/sites pages for this user.
 *   3. Seed play_sessions with a baseline row per appid, seed site_times
 *      with server totals. Subsequent heartbeats add on top.
 *
 * Skipped in fakeRedeem mode — the dev stub user has no server record.
 * Failure policy: best-effort. If fetch fails, we still clear tables and
 * proceed with empty local state. Metrics flusher will still run, but its
 * first flush will essentially be zero + local delta. We trade "possible
 * over-count on server" for "user can always log in" — the alternative
 * (blocking sign-in on flaky metrics endpoint) is worse UX. A fast-follow
 * retry could be added if we see real drift.
 */
async function seedLocalFromServer(userId: string): Promise<void> {
  clearUserTables();
  if (fakeRedeem) {
    log.info('[seed] fakeRedeem — skipping server fetch');
    return;
  }
  try {
    const [games, sites] = await Promise.all([
      api.listAllGameMetrics(userId),
      api.listAllSiteMetrics(userId),
    ]);
    for (const m of games) seedGameBaseline(m.appid, m.play_time_minutes);
    for (const m of sites) seedSiteTime(m.domain, m.time_spent_minutes);
    log.info(
      `[seed] hydrated from server: ${games.length} game baseline(s), ${sites.length} site total(s)`
    );
  } catch (err) {
    log.warn('[seed] server fetch failed, proceeding with empty local:', (err as Error).message);
  }
}

/**
 * Steam CDN URLs by appid. Public, no auth. Use the `cdn.cloudflare` host
 * (not `shared.cloudflare`) because the latter 301-redirects to
 * `shared.steamstatic.com` — and the <img> element would then fail CSP.
 *   - capsule_184x69: small horizontal badge.
 *   - header.jpg: 460x215 landscape — matches library card aspect.
 */
const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
const steamIconUrl = (appid: number) => `${STEAM_CDN}/${appid}/capsule_184x69.jpg`;
const steamLogoUrl = (appid: number) => `${STEAM_CDN}/${appid}/header.jpg`;

// Project the credential-free AccountAvailableRead (or AccountRead if we
// ever feed it in) into PublicAccount for the renderer.
function projectPublic(
  accounts: Array<AccountAvailableRead | AccountRead>,
  userTrustLevel: number
): PublicAccount[] {
  return accounts.map((a) => ({
    id: a.id,
    appid: a.appid,
    game_name: a.game_name,
    iconUrl: steamIconUrl(a.appid),
    logoUrl: steamLogoUrl(a.appid),
    min_trust_level: a.min_trust_level,
    locked: a.min_trust_level > userTrustLevel,
    status: 'not_installed',
    downloadPercent: null,
    downloadStage: null,
    guardHint: null,
    downloadError: null,
    downloadErrorPlatforms: null,
    downloadBytesDownloaded: null,
    downloadBytesTotal: null,
  }));
}

/**
 * Per-entry: if the ledger or the on-disk install dir shows the game is
 * actually installed, flip `status` to 'installed'. Also re-asserts the
 * ledger row so a placeholder name from `rescanInstallRoot()` gets
 * upgraded to the real `game_name` once we know it.
 *
 * Verifies physically — a ledger row whose install path was wiped (user
 * deleted the folder) is treated as not installed, so the UI offers
 * "Install" instead of a Play button that would explode on launch.
 */
function mergeInstallState(entries: PublicAccount[]): PublicAccount[] {
  return entries.map((g) => {
    const row = getInstall(g.appid);
    const probablePath = row?.path ?? installPathFor(g.appid);
    if (!existsSync(probablePath) || !hasGameExe(probablePath)) return g;
    // Files on disk are necessary but NOT sufficient: DD pre-allocates every
    // file to full size, so an interrupted download looks "present" while its
    // big archives are zero-filled. Require a real completion signal before
    // presenting Play — otherwise leave the entry not-installed so the card
    // offers Download, which resumes the partial tree via DD.
    if (!isInstallComplete(probablePath)) return g;
    if (
      !row ||
      row.status !== 'installed' ||
      row.path !== probablePath ||
      row.name !== g.game_name
    ) {
      upsertInstall(g.appid, g.game_name, 'installed', probablePath);
    }
    return { ...g, status: 'installed' as const };
  });
}

/**
 * Current game-session state for the renderer: whether play is unlocked and
 * how long that lasts. Drives the titlebar countdown and the task prompt.
 * Returns null when signed out or when the API can't be reached — callers
 * treat null as "unknown" and simply show nothing rather than claiming the
 * session has lapsed.
 */
ipcMain.handle('session:game', async () => {
  if (!currentUser || fakeRedeem) return null;
  try {
    return await api.getMyGameSession();
  } catch (err) {
    log.warn('[game-session] status fetch failed', (err as Error).message);
    return null;
  }
});

// Re-check for the access modal. Returns the gate's own verdict so the dialog
// can tell "you haven't done the task yet" apart from "we couldn't ask".
ipcMain.handle('session:check', async (): Promise<GameSessionVerdict> => {
  if (!currentUser) return 'required';
  if (fakeRedeem) return 'ok';
  return requireGameSession();
});

/**
 * The launcher's language as Steam names it, for DepotDownloader's
 * `-language`. Undefined when we have no mapping, which leaves DD on its own
 * default rather than guessing.
 */
function steamLanguage(): string | undefined {
  return steamLanguageFor(resolveActiveLanguage());
}

/** `checkGameSession` bound to the live API client. Kept as a one-liner so
 *  the gate module itself stays free of module-level singletons and testable. */
function requireGameSession(): Promise<GameSessionVerdict> {
  return checkGameSession({ fetchSession: () => api.getMyGameSession() });
}

/** The gate's verdict as an IPC error, or null when the caller may proceed. */
async function gameSessionBlock(): Promise<string | null> {
  if (fakeRedeem) return null;
  const verdict = await requireGameSession();
  if (verdict === 'required') return 'game_session_required';
  // Could not reach the server. Refusing here is the point: an unreachable
  // API is exactly the state an unentitled client would want to be in, so we
  // do not start anything we cannot first confirm the user may start.
  if (verdict === 'unreachable') return 'session_check_failed';
  return null;
}

// ── IPC handlers ────────────────────────────────────────────────────────

ipcMain.handle('auth:status', (): SessionStatus => session);

ipcMain.handle('auth:redeem', async (_evt, raw: unknown): Promise<RedeemResult> => {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'invalid', message: 'empty code' };
  }
  const code = raw.trim();
  setSession({ state: 'redeeming' });
  try {
    const resp = await api.redeem(code);
    // AuthCodeRedeemRead.user is required per the 2026-04 schema.
    const user: UserRead = resp.user;

    // Seed local SQLite from server-side totals BEFORE starting the metrics
    // flusher — otherwise the first flush would overwrite server totals with
    // our freshly-zeroed local values. Clear-first guarantees no data from
    // a previous session contaminates this one.
    await seedLocalFromServer(user.id);

    setSession({ state: 'signed_in', user });
    saveStoredUser(paths.authUser, user);
    library = []; // reset cache
    // Server-side balance reconcile. Take the freshly returned authoritative
    // balance and rewrite the local ledger to match — server wins.
    if (featureFlags.balanceEnabled && !fakeRedeem) {
      void (async () => {
        try {
          const fresh = await getServerBalance();
          if (fresh !== null) reconcileWithServer(fresh);
          else reconcileWithServer(user.balance);
        } catch (err) {
          log.warn('[balance] sign-in reconcile failed:', (err as Error).message);
        }
      })();
    }

    return { ok: true };
  } catch (err) {
    const code2 =
      err instanceof ApiError ? err.code : 'service_unavailable';
    const message = err instanceof Error ? err.message : 'unknown error';
    setSession({ state: 'error', error: message });
    const mapped =
      code2 === 'not_found'
        ? 'not_found'
        : code2 === 'expired'
          ? 'expired'
          : 'service_unavailable';
    return { ok: false, error: mapped, message };
  }
});

ipcMain.handle('auth:logout', () => {
  api.logout();
  clearStoredUser(paths.authUser);
  library = [];
  setSession({ state: 'signed_out' });
  return { ok: true };
});

ipcMain.handle('library:list', async (): Promise<PublicAccount[]> => {
  if (!currentUser) return [];
  if (library.length > 0) return library;
  if (fakeRedeem) {
    library = dedupeByAppid(devStubAccounts(currentUser.trust_level));
    return library;
  }
  // Let real errors propagate to the renderer — its refreshLibrary() catch
  // sets state to { kind: 'error' }, which lights up the error view + retry
  // button. Swallowing here used to make that branch unreachable: a 5xx or
  // network outage was indistinguishable from "your library is empty",
  // leaving the user with no retry affordance.
  try {
    const accounts = await api.listAvailableAccounts(currentUser.id);
    library = dedupeByAppid(
      mergeInstallState(projectPublic(accounts, currentUser.trust_level))
    );
    return library;
  } catch (err) {
    log.warn('[library] listAvailableAccounts failed:', (err as Error).message);
    throw err;
  }
});

/**
 * Run DepotDownloader with -validate against an installed game. Two modes:
 *
 *   detect (forceDownload=false): stop the instant DD decides to pull
 *     delta (`Downloading depot N`) — we cancel DD BEFORE any bytes land
 *     and return 'update_available'. Nothing on disk changes, so the
 *     caller can ask the user first without having committed to a
 *     multi-GB download or leaving a half-patched install.
 *
 *   apply (forceDownload=true): let DD run to completion, pulling the
 *     delta. The downloader's close handler then re-runs the DRM patcher
 *     and redist step before we resolve 'updated'.
 *
 * A validate pass that never reaches `Downloading depot N` means the
 * install is current → 'no_update'. Because the game is already
 * installed, the downloader leaves its ledger status untouched on cancel
 * or a failed validate (see the `opts.updateMode` guards there), so a
 * deferred/failed update never demotes a working game to 'error'.
 */
type UpdateCheckOutcome = 'no_update' | 'updated' | 'update_available';
async function performUpdateCheck(
  accountId: string,
  appid: number,
  gameName: string,
  userId: string,
  forceDownload: boolean
): Promise<UpdateCheckOutcome> {
  // Drop any warm steam-user session — concurrent sessions on the same
  // account trip RateLimitExceeded.
  logOffSteam();
  return new Promise<UpdateCheckOutcome>((resolve, reject) => {
    let settled = false;
    // In detect mode we cancel DD ourselves the moment a real download
    // starts; this flag tells the done handler that the resulting
    // 'cancelled' is our "there's an update" signal, not a failure.
    let cancelledForPrompt = false;
    let downloadEverStarted = false;

    const settle = (err: Error | null, outcome?: UpdateCheckOutcome) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(outcome ?? 'no_update');
    };

    void startDownload(
      accountId,
      appid,
      gameName,
      (p) => {
        if (p.done) {
          if (cancelledForPrompt) {
            // Detect mode: we stopped DD before any delta bytes landed.
            // The install is untouched; tell the caller an update exists.
            settle(null, 'update_available');
            return;
          }
          if (p.error) settle(new Error(p.error));
          else {
            // Prefer the authoritative summary over the in-flight flag.
            // DD may exit before the watcher sees the line (network blip,
            // tiny delta) — in that case the summary still tells the truth.
            const updated =
              typeof p.downloadedBytes === 'number'
                ? p.downloadedBytes > 0
                : downloadEverStarted;
            settle(null, updated ? 'updated' : 'no_update');
          }
          return;
        }
        // The downloader fires `manifestChanged: true` exactly once, when
        // DepotDownloader has to fetch a depot manifest it doesn't already
        // have — which is what "this depot changed" means. It lands before
        // any file bytes, so there is still time to ask the user.
        if (p.manifestChanged) {
          downloadEverStarted = true;
          if (!forceDownload) {
            // Detect mode: an update exists. Stop DD BEFORE it pulls delta
            // so we can ask the user first — cancelDownload triggers DD's
            // SIGTERM path, and the done branch above maps the resulting
            // 'cancelled' to 'update_available'.
            cancelledForPrompt = true;
            cancelDownload(appid);
            return;
          }
        }
        // `downloading` phase from the parser is the public progress label;
        // it's safe to show even before `manifestChanged` flips because
        // the renderer only treats it as a UI hint.
        const phase = downloadEverStarted ? 'updating' : 'checking';
        sendToRenderer('game:launchProgress', {
          appid,
          phase,
          percent: p.percent,
        });
      },
      userId,
      { updateMode: true, language: steamLanguage() }
    ).catch((err) => settle(err as Error));
  });
}

// One-shot rendezvous for the renderer's update-confirm dialog. Indexed
// by appid so two concurrent launches can't trample each other (rare but
// possible if the user double-clicks fast).
const pendingUpdateDecisions = new Map<number, (proceed: boolean) => void>();

/**
 * Launch a game on a specific pool account. Renderer passes the accountId
 * of the card that was clicked — this is also how we associate an appid
 * with an account for metrics: POST /metrics/games needs both, and without
 * the pairing the server can't decide which pool account's lock to hold.
 *
 * Steps:
 *   1. Validate. Record appid↔accountId pairing.
 *   2. (Unless skipUpdateCheck) Run DD -validate to delta-update the install.
 *   3. Spawn the game executable directly from the install dir. The locally
 *      installed Steam client already owns the user session and picks up
 *      the running process for overlay / playtime / cloud saves. No second
 *      pool-account login is needed (and historically that login crashed
 *      with `tokenAudiences` when the refresh token was minted for web/
 *      mobile but lacked the `client` audience required by the CM).
 */
ipcMain.handle('game:launch', async (_evt, raw: unknown) => {
  let appidRaw: unknown = raw;
  let skipUpdateCheck = false;
  if (raw && typeof raw === 'object' && 'appid' in raw) {
    appidRaw = (raw as { appid: unknown }).appid;
    skipUpdateCheck = !!(raw as { skipUpdateCheck?: unknown }).skipUpdateCheck;
  }
  const appid = Number(appidRaw);
  if (!Number.isInteger(appid) || appid <= 0) {
    return { ok: false, error: 'bad_appid' };
  }
  if (!currentUser) return { ok: false, error: 'not_signed_in' };
  // No time-balance gate any more. Access is earned by completing the tasks
  // the backend issues every few hours, which is what the game session below
  // represents — a remaining-seconds balance no longer decides who may play.

  // A pool account can own MANY games, so /available returns several rows with
  // the SAME account id — appid is the unique per-game key (the list is deduped
  // by appid). Match on appid; the account to drive is the matched row's id.
  const entry = library.find((g) => g.appid === appid);
  if (!entry) return { ok: false, error: 'unknown_account' };
  if (entry.locked) return { ok: false, error: 'locked' };
  if (startsInFlight.has(entry.appid)) {
    return { ok: false, error: 'already_running' };
  }
  const accountId = entry.id;
  startsInFlight.add(entry.appid);
  try {
  // Playing needs a live game session. Check BEFORE the update check — that
  // path logs DepotDownloader into a pool account, whose credentials are
  // themselves gated, so without this the user would sit through a 30 s login
  // just to fail on a 403.
  const sessionBlock = await gameSessionBlock();
  if (sessionBlock) return { ok: false, error: sessionBlock };

  const finishProgress = () =>
    sendToRenderer('game:launchProgress', {
      appid: entry.appid,
      phase: 'idle',
      percent: 0,
    });

  if (!skipUpdateCheck && !fakeRedeem) {
    // TTL cache: a fresh "no update" verdict lets us skip the 10-30s DD
    // login round-trip on the very next launch. We only short-circuit on
    // the negative verdict — if last check said "has update" we still
    // re-check so the user isn't pinned to a stale prompt forever.
    const ttlHours = Math.max(0, getSettings().updateCheckTtlHours);
    const last = ttlHours > 0 ? getLastUpdateCheck(entry.appid) : undefined;
    const ttlMs = ttlHours * 3_600_000;
    const cacheFresh =
      !!last &&
      !last.had_update &&
      Date.now() - last.checked_at < ttlMs;

    if (!cacheFresh) {
      sendToRenderer('game:launchProgress', {
        appid: entry.appid,
        phase: 'checking',
        percent: 0,
      });
      try {
        // Phase 1 — detect only. Returns 'update_available' WITHOUT having
        // downloaded anything (DD is cancelled before the first delta byte).
        const detected = await performUpdateCheck(
          accountId,
          entry.appid,
          entry.game_name,
          currentUser.id,
          false
        );

        if (detected === 'update_available') {
          // Block the launch on the user's choice — the prompt is now a
          // real gate, not a race against a download already in flight.
          const proceed = await new Promise<boolean>((res) => {
            pendingUpdateDecisions.set(entry.appid, res);
            sendToRenderer('game:update_available', { appid: entry.appid });
          });
          pendingUpdateDecisions.delete(entry.appid);

          if (proceed) {
            // Phase 2 — apply: let DD pull the delta this time.
            sendToRenderer('game:launchProgress', {
              appid: entry.appid,
              phase: 'updating',
              percent: 0,
            });
            await performUpdateCheck(
              accountId,
              entry.appid,
              entry.game_name,
              currentUser.id,
              true
            );
            recordUpdateCheck(entry.appid, false);
          } else {
            // User deferred: launch the current build. Re-check next launch
            // (don't cache the negative verdict).
            recordUpdateCheck(entry.appid, true);
          }
        } else {
          // 'no_update' or (defensively) 'updated' — install is current.
          recordUpdateCheck(entry.appid, false);
        }
      } catch (err) {
        pendingUpdateDecisions.delete(entry.appid);
        finishProgress();
        log.warn('[launch] update check failed:', (err as Error).message);
        return {
          ok: false,
          error: 'update_check_failed',
          message: (err as Error).message,
        };
      }
    } else {
      log.info('[launch] update-check cache hit, skipping DD', {
        appid: entry.appid,
        ageMs: Date.now() - last.checked_at,
      });
    }
  }

  sendToRenderer('game:launchProgress', {
    appid: entry.appid,
    phase: 'launching',
    percent: 100,
  });

  accountByAppid.set(entry.appid, accountId);
  try {
    const r = await launchGame(entry.appid);
    if (!r.ok) {
      accountByAppid.delete(entry.appid);
    }
    finishProgress();
    return r;
  } catch (err) {
    accountByAppid.delete(entry.appid);
    finishProgress();
    return { ok: false, error: (err as Error).message };
  }
  } finally {
    startsInFlight.delete(entry.appid);
  }
});

ipcMain.handle('game:update_decision', (_evt, raw: unknown) => {
  // Renderer answers the "update available" prompt. Payload shape:
  //   { appid: number, install: boolean }
  // We resolve the matching pending promise and drop it from the map.
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'bad_payload' };
  const { appid, install } = raw as { appid?: unknown; install?: unknown };
  if (typeof appid !== 'number' || !Number.isInteger(appid)) {
    return { ok: false, error: 'bad_appid' };
  }
  const resolver = pendingUpdateDecisions.get(appid);
  if (!resolver) return { ok: false, error: 'no_pending_decision' };
  pendingUpdateDecisions.delete(appid);
  resolver(!!install);
  return { ok: true };
});

ipcMain.handle('download:start', async (_evt, rawAppid: unknown) => {
  const appid = Number(rawAppid);
  if (!Number.isInteger(appid) || appid <= 0) {
    return { ok: false, error: 'bad_appid' };
  }
  if (!currentUser) return { ok: false, error: 'not_signed_in' };
  // Same as launch: the game session is the only gate on installing.
  // Multi-game accounts share one account id across many /available rows, so
  // appid is the unique per-game key (list is deduped by appid). Match on it;
  // the pool account to download from is the matched row's id.
  const entry = library.find((g) => g.appid === appid);
  if (!entry) return { ok: false, error: 'unknown_account' };
  const accountId = entry.id;
  if (entry.locked) return { ok: false, error: 'locked' };
  if (isQueuedOrActive(entry.appid) || startsInFlight.has(entry.appid)) {
    return { ok: false, error: 'already_downloading' };
  }
  startsInFlight.add(entry.appid);
  try {
  // Same gate as launch: the download pulls pool credentials, which need a
  // live game session. Prompt up front rather than 30 s into a DD login.
  const sessionBlock = await gameSessionBlock();
  if (sessionBlock) return { ok: false, error: sessionBlock };

  // Pre-flight platform check: refuse to start DD when the Steam Store
  // says the game is unavailable on the host OS. Saves a 30+ second login
  // round-trip and a misleading "0 bytes from 0 depots" failure later.
  const here = currentGamePlatform();
  if (here) {
    try {
      const details = await getSteamAppDetails(entry.appid, resolveActiveLanguage());
      const supported = supportedPlatforms(details);
      if (supported.length > 0 && !supported.includes(here)) {
        log.warn('[download] platform mismatch', {
          appid: entry.appid,
          here,
          supported,
        });
        sendToRenderer('download:progress', {
          appid: entry.appid,
          percent: 0,
          done: true,
          error: 'unsupported_platform',
          errorPlatforms: supported,
        });
        return {
          ok: false,
          error: 'unsupported_platform',
          platforms: supported,
        };
      }
    } catch (err) {
      // Best effort: a Store outage shouldn't block legitimate downloads.
      log.warn('[download] pre-flight platform check failed', (err as Error).message);
    }
  }

  const item: QueuedDownload = {
    accountId,
    appid: entry.appid,
    gameName: entry.game_name,
    userId: currentUser.id,
  };

  // If a download is already in flight, queue this one — the vault only
  // permits one account session at a time, so we serialise. The card shows
  // a "queued" state until the active download completes and we dequeue it.
  if (activeDownloadAppid !== null) {
    downloadQueue.push(item);
    log.info('[download] queued', { appid: entry.appid, queueLen: downloadQueue.length });
    upsertInstall(entry.appid, entry.game_name, 'downloading', installPathFor(entry.appid));
    downloadProgressListener({
      appid: entry.appid,
      percent: 0,
      done: false,
      stage: { phase: 'queued' },
    });
    return { ok: true, queued: true };
  }

  beginDownload(item);
  return { ok: true };
  } finally {
    startsInFlight.delete(entry.appid);
  }
});

ipcMain.handle('download:cancel', async (_evt, rawAppid: unknown) => {
  const appid = Number(rawAppid);
  if (!Number.isInteger(appid) || appid <= 0) return { ok: false, error: 'bad_appid' };
  // Queued but not yet started: just drop it from the queue and reset the
  // card. Nothing is on disk and no DD process exists to cancel.
  const qIdx = downloadQueue.findIndex((q) => q.appid === appid);
  if (qIdx >= 0) {
    downloadQueue.splice(qIdx, 1);
    removeInstall(appid); // drop the placeholder 'downloading' ledger row
    library = library.map((g) =>
      g.appid !== appid
        ? g
        : {
            ...g,
            status: 'not_installed' as const,
            downloadPercent: null,
            downloadStage: null,
            downloadError: null,
            downloadErrorPlatforms: null,
            guardHint: null,
            downloadBytesDownloaded: null,
            downloadBytesTotal: null,
          }
    );
    sendToRenderer('install:removed', { appid });
    log.info('[download] dequeued', { appid, queueLen: downloadQueue.length });
    return { ok: true };
  }
  // A stall auto-resume may be scheduled with no live DD process for
  // cancelDownload to kill (the stalled run already exited). Tear the resume
  // down so the user's cancel sticks instead of the download popping back;
  // the partial tree stays on disk and remains resumable via Download.
  if (resumePending.has(appid) && appid === activeDownloadAppid) {
    clearStallState(appid);
    activeDownloadAppid = null;
    activeDownloadItem = null;
    library = library.map((g) =>
      g.appid !== appid
        ? g
        : {
            ...g,
            status: 'not_installed' as const,
            downloadPercent: null,
            downloadStage: null,
            downloadError: null,
            downloadErrorPlatforms: null,
            guardHint: null,
            downloadBytesDownloaded: null,
            downloadBytesTotal: null,
          }
    );
    sendToRenderer('download:progress', { appid, percent: 0, done: true });
    log.info('[download] cancelled pending auto-resume', { appid });
    setImmediate(() => processDownloadQueue());
    return { ok: true };
  }
  const cancelled = cancelDownload(appid);
  return { ok: cancelled };
});

/**
 * Uninstall: wipe the game's install directory from disk, drop its ledger
 * row, and tell the renderer to refresh. Refuses if the enforcer says the
 * game is currently running — the user must quit first, otherwise we'd be
 * yanking files out from under a live process.
 */
ipcMain.handle('install:remove', async (_evt, rawAppid: unknown) => {
  const appid = Number(rawAppid);
  log.info('[install:remove] received', { appid });
  try {
    const result = await uninstallGame(appid, {
      getInstall,
      removeInstall,
      getEnforcingAppid,
      installPathFor,
      pathExists: existsSync,
      fsRm: rm,
    });
    if (!result.success) {
      log.warn('[install:remove] failed', { appid, error: result.error });
      return result;
    }
    // Reflect the change in the in-memory library cache so the next
    // `library:list` (and the broadcast below) carry the new status without
    // a server round-trip.
    library = library.map((g) =>
      g.appid !== appid
        ? g
        : {
            ...g,
            status: 'not_installed' as const,
            downloadPercent: null,
            downloadStage: null,
            downloadError: null,
            downloadErrorPlatforms: null,
            guardHint: null,
            downloadBytesDownloaded: null,
            downloadBytesTotal: null,
          }
    );
    sendToRenderer('install:removed', { appid });
    log.info('[install:remove] ok', { appid });
    return result;
  } catch (err) {
    // Hard-belt: a thrown exception inside the handler used to bubble up as
    // an unhandled rejection on the renderer side and silently freeze the
    // awaiter. Convert to a structured error so the user always sees a
    // dialog instead of a frozen window.
    log.error('[install:remove] threw', {
      appid,
      err: (err as Error).message,
      stack: (err as Error).stack,
    });
    return { success: false, error: (err as Error).message };
  }
});

// ── Settings ────────────────────────────────────────────────────────────
ipcMain.handle('settings:get', () => getSettings());

ipcMain.handle('settings:chooseInstallDir', async () => {
  const current = getSettings().installRoot;
  const result = await dialog.showOpenDialog({
    title: tMain('dialog.choose_install_dir.title'),
    defaultPath: current,
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: tMain('dialog.choose_install_dir.button'),
  });
  if (result.canceled || result.filePaths.length === 0) return { ok: false };
  const dir = result.filePaths[0];
  if (!dir) return { ok: false };
  updateSettings({ installRoot: dir });
  return { ok: true, installRoot: dir };
});

/**
 * Persist the user's language choice. 'auto' means follow the OS locale.
 * Returns the resolved code so the renderer can apply it to i18next
 * without a second IPC roundtrip — the renderer's own resolver would
 * agree, but we keep the source of truth on main.
 */
ipcMain.handle('settings:setLanguage', (_evt, raw: unknown): string => {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : 'auto';
  updateSettings({ language: value });
  return resolveActiveLanguage();
});

/**
 * Persist the auto-update toggle. UI-only for now — electron-updater is
 * always wired with autoInstallOnAppQuit=true; the toggle exists so the
 * preference round-trips and we have a stable IPC channel to flip
 * downstream behavior off in a follow-up.
 */
/**
 * Bytes an install occupies on disk. Walks the tree, so the renderer asks once
 * per game (when the rail expands it) rather than on every render. Returns
 * null when the game isn't installed — the UI then simply omits the row
 * instead of showing a fabricated 0 B.
 */
ipcMain.handle('install:size', (_evt, raw: unknown): number | null => {
  const appid = Number(raw);
  if (!Number.isInteger(appid) || appid <= 0) return null;
  const row = getInstall(appid);
  const dir = row?.path ?? installPathFor(appid);
  if (!existsSync(dir)) return null;
  try {
    return dirBytes(dir);
  } catch (err) {
    log.warn('[install] size probe failed', { appid, err: (err as Error).message });
    return null;
  }
});

ipcMain.handle('settings:setAutoUpdate', (_evt, raw: unknown): boolean => {
  const value = !!raw;
  updateSettings({ autoUpdate: value });
  return value;
});

/**
 * Pin/unpin a game. Returns the new favourites list so the renderer renders
 * from what actually persisted rather than optimistically guessing — the
 * sidebar, the titlebar strip and the catalog stars all read from it.
 *
 * Toggle rather than set: the renderer never has to send the whole array, so
 * two rapid clicks can't race a stale copy over a fresh one.
 */
ipcMain.handle('settings:toggleFavorite', (_evt, raw: unknown): number[] => {
  const appid = Number(raw);
  if (!Number.isInteger(appid) || appid <= 0) return getSettings().favorites;
  const current = getSettings().favorites;
  const next = current.includes(appid)
    ? current.filter((id) => id !== appid)
    : [...current, appid];
  return updateSettings({ favorites: next }).favorites;
});

/**
 * Boot-time payload for the renderer's i18n init: current OS locale and
 * the saved language override. Renderer combines these via resolveLocale
 * before mounting React, so the very first paint is already localised.
 */
ipcMain.handle('i18n:getEnv', () => ({
  osLocale: app.getLocale(),
  language: getSettings().language,
}));

/**
 * Renderer-visible balance. When server sync is enabled, prefer the cached
 * authoritative value (30s TTL); on cache miss or failure, fall back to the
 * local SQLite sum so the UI never blanks on a flaky network.
 */
ipcMain.handle('ledger:balance', async () => {
  const server = await getServerBalance();
  return server ?? getBalance();
});

// ── App metadata ────────────────────────────────────────────────────────
// Surfaced on Settings → About. Versions come from the runtime so packaged
// builds report what's actually installed (not whatever's in source).
ipcMain.handle('app:version', () => ({
  app: app.getVersion(),
  electron: process.versions.electron,
  platform: process.platform,
}));

// ── Feature flags ───────────────────────────────────────────────────────
// Renderer pulls the resolved snapshot on mount; future server-poll-driven
// refreshes will emit 'feature-flags:changed' to push the new payload.
ipcMain.handle('feature-flags:get', (): FeatureFlags => featureFlags);

// ── Tasks (the API /tasks) ──────────────────────────────────────────────────
function devStubTasks(userId: string): TaskRead[] {
  return [
    {
      id: 'stub-task-1',
      user_id: userId,
      title: tMain('devstub.task.review_stardew.title'),
      description: 'https://en.wikipedia.org/wiki/Stardew_Valley',
      status: 'pending',
    },
    {
      id: 'stub-task-2',
      user_id: userId,
      title: tMain('devstub.task.survey.title'),
      description: apiBaseUrl(),
      status: 'pending',
    },
    {
      id: 'stub-task-3',
      user_id: userId,
      title: tMain('devstub.task.completed_example.title'),
      description: null,
      status: 'completed',
    },
  ];
}

ipcMain.handle('tasks:list', async (): Promise<TaskRead[]> => {
  if (!currentUser) return [];
  if (fakeRedeem) return devStubTasks(currentUser.id);
  try {
    const page = await api.listTasks({
      page: 1,
      limit: 50,
      user_id: currentUser.id,
      status: 'pending',
    });
    return page.items;
  } catch (err) {
    log.warn('[tasks] list failed:', (err as Error).message);
    return [];
  }
});

// ── Statistics (local play_sessions aggregate) ──────────────────────────
ipcMain.handle('stats:gameTotals', async () => {
  const totals = sumPlaySecondsByApp();
  const nameByApp = new Map<number, string>();
  for (const g of library) nameByApp.set(g.appid, g.game_name);
  return [...totals.entries()]
    .map(([appid, seconds]) => ({
      appid,
      name: nameByApp.get(appid) ?? `App ${appid}`,
      seconds,
    }))
    .sort((a, b) => b.seconds - a.seconds);
});

ipcMain.handle('tasks:complete', async (_evt, rawId: unknown) => {
  if (typeof rawId !== 'string' || !rawId.trim()) {
    return { ok: false, error: 'bad_id' };
  }
  const id = rawId.trim();
  const reason = `task:${id}`;

  if (!fakeRedeem) {
    try {
      await api.patchTask(id, { status: 'completed' });
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  // Optimistic local earn so the UI flips instantly. PATCH already succeeded
  // above, so the backend has credited the user (or will, depending on its
  // own pipeline). Idempotent: double-click / PATCH retry cannot double-earn
  // because hasLedgerReason gates the second insert.
  if (!hasLedgerReason(reason)) {
    earn(TASK_REWARD_SECONDS, reason);
  }

  // Reconcile with the authoritative server balance in the background.
  // Skip in fakeRedeem (no backend) and when the feature flag is off
  // (local-only mode). Failures degrade gracefully — the optimistic local
  // value stays and the next reconcile (sign-in, ledger:balance read) gets
  // another chance.
  if (!fakeRedeem && featureFlags.balanceEnabled) {
    void (async () => {
      try {
        const fresh = await getServerBalance({ force: true });
        if (fresh !== null) reconcileWithServer(fresh);
      } catch (err) {
        log.warn('[tasks:complete] reconcile failed:', (err as Error).message);
      }
    })();
  }
  return { ok: true };
});

// Steam Store appdetails — public, no auth. Renderer hits this when the
// user opens the in-app game detail page; we cache for 7 days in main.
ipcMain.handle('steam:app-details', async (_evt, payload: unknown) => {
  if (!payload || typeof payload !== 'object') return null;
  const { appid, locale } = payload as { appid?: unknown; locale?: unknown };
  if (typeof appid !== 'number' || !Number.isInteger(appid) || appid <= 0) {
    return null;
  }
  const lang = typeof locale === 'string' && locale.trim() ? locale.trim() : 'en';
  return getSteamAppDetails(appid, lang);
});

// Steam announcements for the open game page. Public, unauthenticated, and
// cached for an hour in main — the section is decoration, so failures come
// back as an empty list rather than an error the page has to render.
ipcMain.handle('steam:news', async (_evt, raw: unknown) => {
  const appid = Number(raw);
  if (!Number.isInteger(appid) || appid <= 0) return [];
  return getSteamAppNews(appid);
});

// Genre labels for the catalog filter. Cache-only answer + background
// fill: whatever the store cache already knows returns immediately, the
// misses resolve via ONE batched PICS lookup (the appinfo "database" —
// no HTTP rate limits) and stream in via 'steam:genres-update'
// broadcasts; the rate-limited Store web API is only consulted for
// titles PICS has no genre data for. The renderer never blocks on this.
const genreService = new GenreService({
  peekDetails: peekSteamAppDetails,
  getGenreIds: (appids) => defaultSteamAppInfoService().getGenreIds(appids),
  mapGenreIds: genreNamesFor,
  fetchDetails: getSteamAppDetails,
  broadcast: (payload) => sendToRenderer('steam:genres-update', payload),
});

ipcMain.handle('steam:genres', (_evt, payload: unknown) => {
  if (!payload || typeof payload !== 'object') return { known: {} };
  const { appids, locale } = payload as { appids?: unknown; locale?: unknown };
  if (!Array.isArray(appids)) return { known: {} };
  const lang = typeof locale === 'string' && locale.trim() ? locale.trim() : 'en';
  const valid = appids
    .filter((a): a is number => typeof a === 'number' && Number.isInteger(a) && a > 0)
    // Hard cap: the library realistically holds tens of games; anything
    // beyond this is a malformed call and would only feed the fetch queue.
    .slice(0, 500);
  return genreService.request(valid, lang);
});

// Renderer pulls queued redeem code on mount.
ipcMain.handle('deeplink:take-code', () => takePendingCode());

// Window controls — the custom titlebar (frame:false) needs an explicit close
// button. mainWindow.close() runs through Electron's normal close flow, so
// any existing 'close' / 'before-quit' handlers (and the OS shutdown
// integration) keep firing exactly as if the user clicked an OS-decoration X.
ipcMain.handle('window:close', () => {
  mainWindow?.close();
});
ipcMain.handle('window:minimize', () => {
  mainWindow?.minimize();
});
ipcMain.handle('window:maximize-toggle', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});

// Synchronous read of the diagnostic-logging flag for the renderer. Read
// once by preload at load time (sendSync) so the renderer's console
// diagnostics honour the same STEAM_CLIENT_LOGGING switch as main.
ipcMain.on('debug:logging-enabled', (evt) => {
  evt.returnValue = isLoggingEnabled();
});

// Open external URL — used by renderer for "get a task" buttons later.
ipcMain.handle('shell:openExternal', async (_evt, url: unknown) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { ok: false, error: 'bad_url' };
  }
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

/**
 * Reveal a game's install directory in the OS file manager.
 *
 * Only ever opens a path we derived ourselves from the ledger or the install
 * root — never a renderer-supplied string — so this can't be turned into an
 * "open anything" primitive. Silently refuses when the game isn't installed.
 */
ipcMain.handle('install:openFolder', async (_evt, raw: unknown) => {
  const appid = Number(raw);
  if (!Number.isInteger(appid) || appid <= 0) return { ok: false, error: 'bad_appid' };
  const row = getInstall(appid);
  const dir = row?.path ?? installPathFor(appid);
  if (!existsSync(dir)) return { ok: false, error: 'not_installed' };
  const err = await shell.openPath(dir);
  // openPath resolves with an error STRING (empty when it worked).
  return err ? { ok: false, error: err } : { ok: true };
});

// ── App lifecycle ───────────────────────────────────────────────────────
// Windows taskbar identity. Must equal the AppUserModelID electron-builder's
// NSIS stamps on the Start Menu / Desktop shortcuts (= appId); otherwise
// Windows can't tie the running window to the pinned shortcut and falls back
// to Electron's default identity — wrong icon on the taskbar and when pinning.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.steamlauncher.client');
}

app.whenReady().then(async () => {
  const port = Number(process.env.SERVER_PORT || 38721);

  // First thing after ready, and before anything makes an API call:
  // safeStorage only works once the app is ready, so this cannot live in the
  // client's constructor (which runs at module scope).
  api.loadPersistedToken();

  // Resolve feature flags before any subsystem (enforcer, IPC handlers,
  // renderer mount) reads them. Subscribe BEFORE the first refresh so the
  // initial publish reaches us (no race where the listener registers a
  // tick too late and misses the broadcast).
  onFeatureFlagsChange((next) => {
    featureFlags = next;
    sendToRenderer('feature-flags:changed', next);
  });
  featureFlags = await refreshFeatureFlags();
  log.info('[feature-flags] resolved', featureFlags);

  // Before the window exists, so the renderer's very first auth:status call
  // already answers "signed in" and no one sees the code screen flash past.
  // safeStorage needs the app to be ready, which is why this is here rather
  // than at module scope beside the client.
  restoreSession();
  // Periodic re-fetch so a flip on the backend reaches running clients
  // without a restart. unref() so the timer doesn't keep the event loop
  // alive past app shutdown.
  setInterval(() => {
    void refreshFeatureFlags();
  }, 5 * 60_000).unref();

  // Token IPC channel must be up before we install the native messaging
  // manifest — Chrome may hit it as soon as the user opens a tab and the
  // extension's service worker fires.
  try {
    await startTokenIpcServer();
  } catch (err) {
    log.error('[server] token IPC server failed to start:', (err as Error).message);
  }

  // Best-effort: install Chrome / Edge native messaging manifests under
  // per-OS directories (POSIX) or registry keys (Windows). Allowed
  // extension IDs come from STEAM_CLIENT_EXT_IDS env (comma-separated)
  // until we bake an official ID into the production extension.
  void installNativeMessagingManifests([]).catch((err) => {
    log.warn('[server] native messaging manifest install failed:', (err as Error).message);
  });

  startServer({
    port,
    token: getServerToken(),
    version: app.getVersion(),
  });
  log.info('[boot] startServer returned, calling createWindow');
  // NB: renderer no longer talks to the local server. The extension
  // obtains the live token via Chrome native messaging
  // (com.steam_client.token) — see server-token.ts and the host script
  // at apps/desktop/native-messaging-host/host.js.

  createWindow();
  log.info('[boot] createWindow returned (async loads may still be pending)');

  if (mainWindow) tray = initTray(mainWindow);
  if (mainWindow) initUpdater(mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  if (mainWindow) {
    mainWindow.webContents.once('did-finish-load', flushDeeplink);
    // Kick off the DRM boot sweep only after the renderer finishes loading,
    // otherwise the early `drm-boot:progress` event with the queue size
    // would fire into a renderer that doesn't yet have the subscription
    // wired and the user wouldn't see the toast appear.
    mainWindow.webContents.once('did-finish-load', () => {
      startBootDrmPatchScan();
    });
  }
});

app.on('before-quit', () => {
  // Mark intent so the close-to-tray hook lets the close fall through
  // when this fires from a non-tray path (e.g. systemd shutdown,
  // keyboard interrupt, OS log-off).
  app.isQuitting = true;
  stopMetricsFlush();
  stopEnforcing('window_closed');
  logOffSteam();
  stopServer();
  stopTokenIpcServer();
  closeLedger();
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    log.info('[lifecycle] window-all-closed → app.quit()');
    app.quit();
  }
});
