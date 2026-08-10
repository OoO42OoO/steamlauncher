/**
 * Cross-platform filesystem paths for the client.
 *
 * Uses `app.getPath(...)` from Electron, which maps to platform-native
 * locations:
 *   - Windows: `%APPDATA%\steam-client`, `%LOCALAPPDATA%\...`.
 *   - Linux:   `~/.config/steam-client`, `~/.local/share/steam-client`, etc.
 *   - macOS:   `~/Library/Application Support/steam-client`.
 *
 * `productName` in package.json is what Electron uses for the directory name,
 * so make sure it stays "steam-client" (no slash or special chars — Windows
 * path rules would choke).
 *
 * The `app` module is safe to query before `app.whenReady()` for these keys
 * (userData, logs, cache, etc.), per Electron docs.
 */
import { app } from 'electron';
import { join, resolve } from 'node:path';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import log from 'electron-log/main.js';

const execFileAsync = promisify(execFile);

// Guard: force the name so windowsy folder resolution lands in a sane spot
// even if package.json productName gets clobbered later.
app.setName('steam-client');

const USER_DATA = app.getPath('userData');
const LOGS = app.getPath('logs');
// Electron has no 'cache' key; keep a subfolder inside userData for
// DepotDownloader's session/sentry files. Same layout on every OS.
const CACHE = join(USER_DATA, 'cache');

export const paths = {
  /** Non-volatile config (tokens, settings). */
  config: USER_DATA,
  /** User data root (also holds the SQLite DB + game installs by default). */
  data: USER_DATA,
  /** Derived cache (DepotDownloader home, etc.). */
  cache: CACHE,
  /** "State" — on Linux maps to ~/.local/state via userData; on Windows the
   *  same as userData. We keep the name for compatibility. */
  state: USER_DATA,
  /** Electron-suggested log folder. */
  logs: LOGS,
  /** Default install root for DepotDownloader (overridable in Settings). */
  games: join(USER_DATA, 'games'),
  /** Encrypted the API Bearer (safeStorage ciphertext). */
  authToken: join(USER_DATA, 'auth-token.bin'),
  /** Encrypted record of the signed-in user, so a restart doesn't cost a
   *  code. Written beside the Bearer and cleared with it. */
  authUser: join(USER_DATA, 'auth-user.bin'),
  /** User preferences JSON. */
  settings: join(USER_DATA, 'settings.json'),
  /** SQLite DB. */
  db: join(USER_DATA, 'steam-client.db'),
};

/**
 * POSIX chmod is mostly meaningful on Linux/macOS. On Windows NTFS the bit
 * mask is ignored — proper restrictions would need ACLs (icacls). Call sites
 * that want "owner-only" semantics should use this helper so we don't silently
 * mislead ourselves about file permissions cross-platform.
 */
export function lockFileMode(path: string, mode: number): void {
  if (process.platform === 'win32') {
    // Per-file ACLs not enforced here; container ACL on the config dir is
    // hardened by `hardenWindowsAcl` (called from `ensurePaths`) and inherits
    // down to children via (OI)(CI).
    return;
  }
  try {
    chmodSync(path, mode);
  } catch {
    /* best-effort — file may not exist yet */
  }
}

/**
 * Self-heal any broken Windows ACL state on `paths.config` and its subtree
 * by resetting to inherit from the parent (%APPDATA%). Older builds tried to
 * harden the tree with `icacls /inheritance:r /grant:r user:(OI)(CI)F`, but
 * the resulting explicit ACEs occasionally became unreadable on next launch
 * — leaving the user with an app that could not be re-opened until they ran
 * `icacls /reset /T` + a manual `Remove-Item -Recurse` by hand. We no longer
 * harden; instead we make every boot a no-op when ACLs are already healthy
 * and a self-repair when they are not.
 *
 * `icacls /reset /T /Q` is idempotent: on a clean tree it just re-applies
 * inheritance (a no-op), on a broken tree it strips explicit ACEs and
 * re-enables inheritance from %APPDATA%.
 *
 * No-op outside Windows. Failure is logged and never thrown.
 */
export async function selfHealWindowsAcl(target: string): Promise<void> {
  if (process.platform !== 'win32') return;
  if (!existsSync(target)) return;
  try {
    await execFileAsync('icacls.exe', [target, '/reset', '/T', '/Q']);
    log.info('Windows ACL self-heal completed for', target);
  } catch (err) {
    log.warn('Windows ACL self-heal failed (non-fatal) for', target, err);
  }
}

export function ensurePaths(): void {
  // Each mkdirSync is wrapped: on Windows a stale ACL on a parent (e.g.
  // %APPDATA%\steam-client\cache from a build that wrote bad inherit flags)
  // raises EACCES synchronously and would kill startup before resetWindowsAclInheritance
  // gets a chance to run. Warn-and-continue lets the subsequent ACL repair
  // step recover; the next failing write surfaces a more diagnosable error.
  for (const p of [
    paths.config,
    paths.data,
    paths.cache,
    paths.state,
    paths.logs,
    paths.games,
  ]) {
    try {
      mkdirSync(p, { recursive: true, mode: 0o700 });
    } catch (err) {
      log.warn('[paths] mkdir failed (continuing)', p, (err as Error).message);
    }
  }
}

/**
 * Locate the DepotDownloader binary for this platform.
 *
 * Resolution order:
 *   1. `DEPOTDOWNLOADER_PATH` env var (developer override, .env / shell).
 *   2. Bundled binary inside `extraResources` of the packaged app:
 *      `<resources>/vendor/<platform>-<arch>/DepotDownloader[.exe]`.
 *   3. Repo-level `vendor/<platform>-<arch>/...` for `pnpm dev` runs.
 *
 * Returns null if nothing is found — caller should surface a clear error.
 *
 * `app.isPackaged` distinguishes dev (vite/electron-vite hot reload) from a
 * production AppImage / NSIS install. In packaged builds Electron exposes
 * `process.resourcesPath`, e.g.:
 *   - Linux AppImage:  `<mount>/resources/vendor/linux-x64/DepotDownloader`
 *   - Windows NSIS:    `<install>/resources/vendor/win-x64/DepotDownloader.exe`
 */
export function resolveDepotDownloaderPath(): string | null {
  const fromEnv = process.env.DEPOTDOWNLOADER_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const exeName =
    process.platform === 'win32' ? 'DepotDownloader.exe' : 'DepotDownloader';
  const subdir =
    process.platform === 'win32'
      ? `win-${process.arch}`
      : `linux-${process.arch}`;

  const bundled = app.isPackaged
    ? join(process.resourcesPath, 'vendor', subdir, exeName)
    : null;
  if (bundled && existsSync(bundled)) return bundled;

  // Dev fallback: repo root is two levels up from out/main/index.js, but
  // since we can't rely on __dirname location, walk up from cwd.
  const repoCandidates = [
    resolve(process.cwd(), 'vendor', subdir, exeName),
    resolve(process.cwd(), '..', '..', 'vendor', subdir, exeName),
  ];
  for (const cand of repoCandidates) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * Locate the x86 (32-bit) ColdClientLoader shipped under
 * `vendor/<platform>-<arch>/gbe_fork/steamclient_loader_x86.exe`.
 *
 * Required for x86-only Steamworks titles (Conflict: Desert Storm, Postal
 * Plus, etc.): the x64 build of the loader bails with "Arch of loader and
 * requested exe are different" when asked to exec a 32-bit main exe, so
 * arch-aware installs must drop and spawn the matching-arch loader. Same
 * resolution order as `resolveDepotDownloaderPath` — env override,
 * packaged extraResources, then repo-level vendor.
 */
export function resolveColdClientLoaderX86Path(): string | null {
  if (process.platform !== 'win32') return null;
  const fromEnv = process.env.STEAM_CLIENT_LOADER_X86_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const exeName = 'steamclient_loader_x86.exe';
  const subdir = `win-${process.arch}`;

  const bundled = app.isPackaged
    ? join(process.resourcesPath, 'vendor', subdir, 'gbe_fork', exeName)
    : null;
  if (bundled && existsSync(bundled)) return bundled;

  const repoCandidates = [
    resolve(process.cwd(), 'vendor', subdir, 'gbe_fork', exeName),
    resolve(process.cwd(), '..', '..', 'vendor', subdir, 'gbe_fork', exeName),
  ];
  for (const cand of repoCandidates) {
    if (existsSync(cand)) return cand;
  }
  return null;
}
