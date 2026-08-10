import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron';
import { join } from 'node:path';
import log from 'electron-log/main.js';

import { tMain } from './i18n';

/**
 * Resolve the tray icon path. The 1000×1000 `icon.png` used for app/window
 * branding is the wrong size for system tray (Windows wants 16/32, Linux
 * AppIndicator wants ~22), so we ship dedicated tray assets:
 *   - Windows: `icon.ico` (multi-size, includes 32×32) — Windows scales it.
 *   - Linux:   `tray-icon.png` (32×32) — looks crisp on GNOME/KDE trays.
 * In dev `import.meta.dirname` is `apps/desktop/out/main` (electron-vite
 * output), so we walk up to `apps/desktop/build/`. In a packaged build the
 * file is shipped as `extraResources` and lives at `process.resourcesPath`.
 */
function resolveIconPath(): string {
  const filename = process.platform === 'win32' ? 'icon.ico' : 'tray-icon.png';
  if (app.isPackaged) return join(process.resourcesPath, filename);
  const devName = process.platform === 'win32' ? 'icon.ico' : 'icon-32.png';
  return join(import.meta.dirname, '../../build', devName);
}

/**
 * Create the system tray with minimize-to-tray behaviour.
 *
 * Returns null if the platform refuses to give us a tray (most common on
 * GNOME 3+ without an AppIndicator extension). The caller MUST treat
 * that as a signal to fall back to the old "X closes app" behaviour, so
 * the user is never left with an invisible-but-running process.
 */
export function initTray(window: BrowserWindow): Tray | null {
  try {
    const image = nativeImage.createFromPath(resolveIconPath());
    if (image.isEmpty()) {
      log.warn('[tray] icon nativeImage is empty, tray creation skipped');
      return null;
    }
    const tray = new Tray(image);
    if (tray.isDestroyed()) {
      log.warn(
        '[tray] tray destroyed immediately after creation — likely no system tray '
          + '(GNOME 3+ without an AppIndicator extension); falling back',
      );
      return null;
    }
    tray.setToolTip('Steam Client');

    const showWindow = (): void => {
      if (window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      window.focus();
    };

    const quitApp = (): void => {
      app.isQuitting = true;
      app.quit();
    };

    const menu = Menu.buildFromTemplate([
      { label: tMain('tray.show'), click: showWindow },
      { type: 'separator' },
      { label: tMain('tray.quit'), click: quitApp },
    ]);
    tray.setContextMenu(menu);

    // Standard Windows behaviour: double-click LMB shows the window.
    tray.on('double-click', showWindow);

    log.info('[tray] system tray initialised');
    return tray;
  } catch (err) {
    log.warn('[tray] initialisation failed, falling back to close-quits-app:', (err as Error).message);
    return null;
  }
}
