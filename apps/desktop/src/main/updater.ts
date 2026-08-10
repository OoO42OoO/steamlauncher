/**
 * electron-updater integration. Wires the auto-updater into the IPC bus so
 * the renderer can render a localized toast covering each phase
 * (checking → available → downloading → downloaded → installed-on-quit).
 *
 * The feed is a directory served over HTTPS holding the
 * latest{,-mac,-linux}.yml files electron-builder produces (the "generic"
 * provider). Its URL is deployment configuration supplied by the build
 * environment — see src/main/endpoints.ts. A build made without one simply
 * never offers updates.
 */
import { BrowserWindow, ipcMain } from 'electron';
import log from 'electron-log/main.js';
import electronUpdater from 'electron-updater';
import { updatesFeedUrl } from './endpoints';

const { autoUpdater } = electronUpdater;


const FIRST_CHECK_DELAY_MS = 5_000;
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let installed = false;
let firstCheckTimer: NodeJS.Timeout | null = null;
let recheckTimer: NodeJS.Timeout | null = null;

export function initUpdater(window: BrowserWindow): void {
  if (installed) {
    log.warn('[updater] already initialised; ignoring repeat call');
    return;
  }
  installed = true;

  autoUpdater.logger = log;
  // Download updates in the background automatically…
  autoUpdater.autoDownload = true;
  // …but NEVER install silently — not even on quit. The update is applied
  // only when the user explicitly clicks "Install & restart" in the toast
  // (ipc 'updater:install-and-restart' → quitAndInstall). Auto-install on
  // quit is confusing here because the window close goes to tray (the app
  // keeps running), so the install would fire at an unpredictable "real
  // quit" moment. Explicit-only keeps it predictable and consent-based.
  autoUpdater.autoInstallOnAppQuit = false;

  const feedUrl = updatesFeedUrl();
  if (feedUrl) {
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl });
      log.info('[updater] feed URL set', feedUrl);
    } catch (err) {
      log.warn('[updater] setFeedURL failed:', (err as Error).message);
    }
  }

  const send = (channel: string, payload?: unknown): void => {
    if (!window || window.isDestroyed()) return;
    window.webContents.send(channel, payload);
  };

  autoUpdater.on('checking-for-update', () => {
    log.info('[updater] checking for update');
    send('updater:checking');
  });

  autoUpdater.on('update-available', (info) => {
    log.info('[updater] update available', { version: info?.version });
    send('updater:available', {
      version: info?.version ?? '',
      releaseNotes:
        typeof info?.releaseNotes === 'string' ? info.releaseNotes : undefined,
    });
  });

  autoUpdater.on('update-not-available', () => {
    log.info('[updater] no update available');
    send('updater:not-available');
  });

  autoUpdater.on('error', (err) => {
    const message = err instanceof Error ? err.message : String(err);
    // Auto-update is a background convenience: a failed check/download
    // (transient network blip, feed unreachable, IP-blocked without VPN)
    // must NOT surface a scary error toast — the user is never blocked. BUT
    // the renderer still needs the signal to DISMISS the "checking…" spinner,
    // otherwise it hangs forever. So we notify the UI, and the toast hides on
    // error (see UpdateToast). Details stay in the log.
    log.warn('[updater] error:', message);
    send('updater:error', { message });
  });

  autoUpdater.on('download-progress', (p) => {
    send('updater:download-progress', {
      percent: p.percent,
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('[updater] update downloaded', { version: info?.version });
    send('updater:downloaded', { version: info?.version ?? '' });
  });

  ipcMain.handle('updater:install-and-restart', () => {
    log.info('[updater] quitAndInstall requested by renderer');
    autoUpdater.quitAndInstall(false, true);
  });

  // Defer the first check so the window has time to mount the toast
  // listeners. Without the delay the 'checking' event can fire before the
  // renderer's `useEffect` has subscribed and the toast misses its
  // opening state — UX regresses to "nothing happens, then surprise
  // restart prompt".
  firstCheckTimer = setTimeout(() => {
    void runCheck();
    recheckTimer = setInterval(() => void runCheck(), RECHECK_INTERVAL_MS);
  }, FIRST_CHECK_DELAY_MS);

  window.once('closed', () => {
    if (firstCheckTimer) {
      clearTimeout(firstCheckTimer);
      firstCheckTimer = null;
    }
    if (recheckTimer) {
      clearInterval(recheckTimer);
      recheckTimer = null;
    }
  });
}

async function runCheck(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // Errors are also delivered via the 'error' event; we just log here so
    // a transient network blip doesn't crash the timer loop.
    log.warn('[updater] checkForUpdates threw:', (err as Error).message);
  }
}
