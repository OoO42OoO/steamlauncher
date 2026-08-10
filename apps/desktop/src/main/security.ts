import { app, BrowserWindow, dialog, session, shell, crashReporter } from 'electron';
import log from 'electron-log/main.js';
import { apiOrigin } from './endpoints';

/**
 * Apply Electron-level security hardening:
 *  - deny-by-default window.open and navigation
 *  - close DevTools in production builds
 *  - block remote debugging flags in prod
 *  - disable crash reporter uploads
 *  - lock session to strict permission model
 */
export function installSecurity(opts: { isDev: boolean }): void {
  // 1. Crash reporter off — do NOT call crashReporter.start(). Minidumps are
  //    written by Chromium Crashpad anyway but without start() they stay local
  //    and Electron does not attempt to upload them.
  try {
    crashReporter.start({
      submitURL: '',
      uploadToServer: false,
      ignoreSystemCrashHandler: true,
      compress: false,
    });
  } catch (err) {
    log.warn('[security] crashReporter.start failed:', (err as Error).message);
  }

  // 2. Block remote debugging flags in packaged builds.
  //    Exits via app.exit(1) with a visible error box — the user must see
  //    why their double-click vanished. Silent exits at startup are the
  //    single worst UX failure mode for a desktop launcher.
  if (!opts.isDev) {
    const badFlags = [
      '--inspect',
      '--inspect-brk',
      '--inspect-wait',
      '--remote-debugging-port',
      '--remote-debugging-pipe',
    ];
    const argv = [...process.argv, ...(process.execArgv || [])].join(' ');
    for (const f of badFlags) {
      if (argv.includes(f)) {
        log.error('[security] refusing to run with', f, '— exiting');
        try {
          dialog.showErrorBox(
            'Steam Client',
            `Refusing to start with debug flag "${f}". Remove it from the launcher / shortcut and try again.`
          );
        } catch (err) {
          log.warn('[security] could not show error dialog:', (err as Error).message);
        }
        app.exit(1);
      }
    }
  }

  // 3. Session permission handler: block notifications, geolocation, media, etc.
  //    `session.defaultSession` is only available after `app.whenReady()` —
  //    deferring the setup keeps installSecurity safe to call at module scope.
  //
  //    We also override Content-Security-Policy in packaged builds. The
  //    meta-CSP shipped in renderer/index.html keeps `'unsafe-inline'` on
  //    script-src so Vite HMR works in `electron-vite dev`. In production
  //    that is unacceptable: we replace the response header with a strict
  //    policy that drops `'unsafe-inline'` (and `'unsafe-eval'`) from
  //    script-src. Style-src keeps `'unsafe-inline'` because Tailwind v4
  //    runtime JIT injects style elements without a nonce — switching to
  //    nonces would touch every Tailwind boundary in the renderer and is
  //    out of scope for this hardening pass.
  const wireSession = () => {
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    session.defaultSession.setPermissionCheckHandler(() => false);

    if (app.isPackaged) {
      // Game-detail page consumes Steam Store assets:
      //   - img-src: screenshots, headers, capsules from *.steamstatic.com
      //     and *.akamaihd.net; the shared.akamai.steamstatic.com host is
      //     covered by *.steamstatic.com, listed explicitly for clarity.
      //   - media-src: HTML5 <video> trailers from Steam's CDNs.
      //   - connect-src: harmless to allow store.steampowered.com here even
      //     though main currently fetches on the renderer's behalf — a future
      //     iteration may move the request to the renderer.
      const productionCsp =
        "default-src 'none'; " +
        "script-src 'self'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https://cdn.cloudflare.steamstatic.com https://*.steamstatic.com https://shared.akamai.steamstatic.com https://*.akamaihd.net https://*.steampowered.com; " +
        "media-src 'self' https://*.steamstatic.com https://video.akamai.steamstatic.com https://video.cloudflare.steamstatic.com; " +
        "font-src 'self' data:; " +
        `connect-src 'self' ${apiOrigin()} https://store.steampowered.com http://127.0.0.1:38721 ws://127.0.0.1:38721; ` +
        "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';";
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        const headers = { ...(details.responseHeaders ?? {}) };
        // Strip any existing CSP header (case-insensitive) — the meta-CSP from
        // index.html is parsed by the renderer separately and Chromium takes
        // the intersection, so a strict header tightens the effective policy.
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'content-security-policy') {
            delete headers[key];
          }
        }
        headers['Content-Security-Policy'] = [productionCsp];
        callback({ responseHeaders: headers });
      });
    }
  };
  if (app.isReady()) {
    wireSession();
  } else {
    app.whenReady().then(wireSession, (err: unknown) => {
      log.warn('[security] session hardening failed:', (err as Error)?.message ?? err);
    });
  }

  // 4. Wire every BrowserWindow after creation.
  app.on('browser-window-created', (_event, win) => {
    hardenWindow(win, opts);
  });
}

function hardenWindow(win: BrowserWindow, opts: { isDev: boolean }): void {
  const wc = win.webContents;

  // 4.1 Deny window.open entirely; route explicit external navigation through
  //     shell.openExternal only.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch((err) => log.warn('[security] openExternal failed:', err.message));
    }
    return { action: 'deny' };
  });

  // 4.2 Block in-renderer navigation to anything but the initial document.
  wc.on('will-navigate', (event, url) => {
    const allowed =
      url.startsWith('http://127.0.0.1:') ||
      url.startsWith('http://localhost:') ||
      url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      log.warn('[security] blocked will-navigate to', url);
    }
  });

  // 4.3 Block attaching webview tags.
  wc.on('will-attach-webview', (event) => event.preventDefault());

  // 4.4 DevTools: closed in prod. In dev we allow so devs can open manually.
  if (!opts.isDev) {
    wc.on('devtools-opened', () => wc.closeDevTools());
  }
}
