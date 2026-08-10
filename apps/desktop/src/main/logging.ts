import log from 'electron-log/main.js';

/**
 * Diagnostic logging is opt-in via the STEAM_CLIENT_LOGGING env var.
 *
 * When it isn't exactly "true" (the production default), every
 * electron-log transport is silenced so all `log.*` calls across main
 * become no-ops — nothing is written to `%APPDATA%\steam-client\logs`,
 * stdout, or the sync shadow log — while the call sites stay in place.
 * Set `STEAM_CLIENT_LOGGING=true` in `.env` to restore full diagnostics
 * for local debugging.
 *
 * One flag drives the whole app: main reads it here; the renderer reads
 * the same value over a synchronous IPC bridge (see `debug:logging` in
 * index.ts / preload) so its `console.warn` diagnostics honour it too.
 */
export function isLoggingEnabled(): boolean {
  return process.env.STEAM_CLIENT_LOGGING === 'true';
}

/**
 * Turn off every electron-log transport. Called at boot when logging is
 * disabled — after this, `log.info/warn/error/debug` do nothing. Guards
 * each transport since the set present depends on electron-log's build.
 */
export function disableAllLogTransports(): void {
  const transports = log.transports as unknown as Record<
    string,
    { level: false | string } | undefined
  >;
  for (const name of ['file', 'console', 'remote', 'ipc']) {
    const transport = transports[name];
    if (transport) transport.level = false;
  }
}
