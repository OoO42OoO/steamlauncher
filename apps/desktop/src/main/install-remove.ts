import log from 'electron-log/main.js';

/**
 * Inputs are passed by the caller so the function stays pure / unit-testable:
 * tests can stub `getInstall`, `removeInstall`, `getEnforcingAppid`,
 * `fsRm`, and `pathExists` without bringing up the full main process.
 */
export interface UninstallDeps {
  getInstall: (appid: number) => { path: string | null } | undefined;
  removeInstall: (appid: number) => void;
  getEnforcingAppid: () => number | null;
  installPathFor: (appid: number) => string;
  pathExists: (path: string) => boolean;
  fsRm: (
    path: string,
    opts: {
      recursive: boolean;
      force: boolean;
      maxRetries?: number;
      retryDelay?: number;
    }
  ) => Promise<void>;
}

export type UninstallResult =
  | { success: true }
  | { success: false; error: string };

export async function uninstallGame(
  appid: number,
  deps: UninstallDeps
): Promise<UninstallResult> {
  if (!Number.isInteger(appid) || appid <= 0) {
    return { success: false, error: 'bad_appid' };
  }
  if (deps.getEnforcingAppid() === appid) {
    return { success: false, error: 'game_running' };
  }
  try {
    const row = deps.getInstall(appid);
    const installDir = row?.path ?? deps.installPathFor(appid);
    if (installDir && deps.pathExists(installDir)) {
      // Bound the Windows retry behaviour: EBUSY/EPERM on a held handle
      // (Explorer preview, antivirus scanner, leftover SecuROM/.unpacked.exe
      // still locked from a previous launch) — without `maxRetries`,
      // fs.rm's default Windows path retries aggressively and the IPC
      // handler hangs the renderer for 60+ seconds, surfacing as an
      // AppHang B1 termination from the OS. Three retries with a short
      // delay is enough to wait out a transient AV scan without freezing
      // the UI; if it still fails we surface a clear error instead of
      // letting the renderer freeze.
      try {
        await deps.fsRm(installDir, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 500,
        });
      } catch (rmErr) {
        const errno = (rmErr as NodeJS.ErrnoException).code;
        log.warn('[install] fs.rm retry budget exhausted', {
          appid,
          installDir,
          errno,
          err: (rmErr as Error).message,
        });
        return {
          success: false,
          error: `rm_failed:${errno ?? 'unknown'}`,
        };
      }
    }
    deps.removeInstall(appid);
    log.info('[install] removed', { appid });
    return { success: true };
  } catch (err) {
    log.error('[install] remove failed', {
      appid,
      err: (err as Error).message,
    });
    return { success: false, error: (err as Error).message };
  }
}
