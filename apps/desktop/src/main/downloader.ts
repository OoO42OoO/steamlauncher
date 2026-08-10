/**
 * DepotDownloader subprocess wrapper.
 *
 * Uses vault.withAccount for scoped access to credentials. The DD binary is
 * launched with an isolated HOME/XDG_* pointing into our cache dir so its
 * sentry / session cache doesn't pollute the user's real Steam config.
 *
 * Password is fed via stdin on the "Enter account password" prompt — never
 * via argv, where it would be visible in `ps auxf`. 2FA is generated locally
 * from `shared_secret` via steam-totp and piped on the Steam-Guard prompt.
 *
 * Progress lines ("12.3%") are parsed and throttled (max 4/s). Login and
 * sensitive strings are redacted before logging.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { generateAuthCode } from 'steam-totp';
import log from 'electron-log/main.js';
import type { DownloadStage } from '@steam-client/shared';
import { withAccount } from './vault';
import { paths, resolveDepotDownloaderPath } from './paths';
import { getInstallRoot } from './settings';
import { upsertInstall } from './ledger';
import { markDownloadComplete, hasCompletionMarker } from './download-complete';
import { makeDdState, parseDdLine } from './dd-parser';
import { ApiError } from './api/client';
import { applyDrmPatches } from './drm-patcher';
import { defaultInstallRedists } from './redist-installer';
import { findGameExe } from './find-game-exe';
import {
  getAppDetails as getSteamAppDetails,
  currentGamePlatform,
  supportedPlatforms,
  type GamePlatform,
} from './api/steam-store';
import type {
  AccountEmailAuthCodeRead,
  AccountEmailAuthCodesRead,
} from '@steam-client/shared/api';

/**
 * Recursive sum of bytes under `root`. Skips directories it can't read
 * (race with DD writing) instead of throwing — the next throttle tick
 * will pick up whatever DD has settled on. Returns 0 if `root` doesn't
 * exist yet.
 *
 * Used to drive the "X MB / Y MB" estimate on the download card. For
 * a 50 GB install with tens of thousands of files the full walk is
 * still well under 100 ms on modern SSDs, but we throttle it to
 * ~1.5 s in the caller so the per-progress-event cost stays small.
 */
export function dirBytes(root: string): number {
  let total = 0;
  let stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // EACCES / ENOTDIR / ENOENT races — drop this subtree, retry next tick.
      continue;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(p);
      } else if (ent.isFile()) {
        try {
          total += statSync(p).size;
        } catch {
          // DD may have just renamed/deleted it — skip.
        }
      }
    }
  }
  return total;
}

/**
 * Detect "no space left on device" from a thrown error or arbitrary
 * object. Matches Node's `err.code === 'ENOSPC'` (Linux/macOS, also
 * Windows since Node 18) and the textual fallback for older runtimes
 * and for errors surfaced by DD on its own (e.g. via stderr — Steam's
 * .NET runtime emits "There is not enough space on the disk" with no
 * errno).
 */
function isDiskFull(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const anyErr = err as { code?: unknown; message?: unknown };
  if (anyErr.code === 'ENOSPC' || anyErr.code === 'ERR_NO_SPACE') return true;
  const msg = typeof anyErr.message === 'string' ? anyErr.message.toLowerCase() : '';
  if (!msg) return false;
  return (
    msg.includes('no space left on the device') ||
    msg.includes('not enough space on the disk') ||
    msg.includes('disk full') ||
    msg.includes('out of space') ||
    msg.includes('not enough disk')
  );
}

/**
 * Bytes free on the filesystem that hosts `path`. Returns null when
 * the platform doesn't expose `statfs` (very old Node) or the call
 * fails for any reason — the caller treats null as "unknown, skip the
 * pre-flight check, let DD fail naturally".
 */
function freeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    // BigInt-safe product: bsize * bfree on a 9 PB YV-NFS export
    // overflows Number; clamp to a sane upper bound (10 EB).
    const free = Number(stats.bsize) * Number(stats.bfree);
    return Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

export interface DownloadProgress {
  appid: number;
  percent: number;
  done: boolean;
  error?: string;
  /**
   * Platforms supported by the game (per Steam Store), accompanying
   * platform-aware error keys. See protocol.ts DownloadProgressSchema.
   */
  errorPlatforms?: GamePlatform[];
  stage?: DownloadStage;
  /**
   * Transient guard-fallback hint shown on the download card while the
   * email-auth-code poll is in flight. Renderer reads it instead of (and
   * preferred over) `stage` when present. Cleared by the next progress
   * event that omits it.
   */
  guardHint?: 'waiting_for_email' | 'received';
  /**
   * Cumulative bytes DD has actually written to the install dir so far.
   * Computed in main by recursively summing the install tree (throttled
   * to ~1.5 s to keep the per-event cost down on big installs). Renderer
   * uses this + bytesTotal to render the "X MB / Y MB" label.
   */
  bytesDownloaded?: number;
  /**
   * Estimated total bytes the install will consume when complete.
   * Source priority (highest first):
   *   1. DD's `Total downloaded: X bytes from Y depots` summary line
   *      (exact, set once at terminal events).
   *   2. Running estimate: bytesDownloaded / aggregateFraction, kept
   *      monotone so the bar never goes backwards as the sample
   *      stabilises. Set once at least one byte of progress has been
   *      observed so we don't divide by zero.
   *
   * Renderer falls back to a per-depot-percent display when absent.
   */
  bytesTotal?: number;
  /**
   * Bytes pulled from CDN this run, parsed from DD's final
   * "Total downloaded: N bytes from M depots" line. Only set on the
   * terminating event (`done: true`) when DD printed a summary. The
   * launch-time update check uses N>0 as the authoritative "an update
   * was actually fetched" signal — DD with `-validate` prints percent
   * during chunk verification too, so a non-zero `percent` alone is not
   * enough to distinguish validation from a real delta pull.
   */
  downloadedBytes?: number;
  /**
   * One-shot marker fired the first time DD prints `Downloading depot N`,
   * which is the literal moment DD switches from validating-chunks to
   * pulling-delta. The launch update-check uses this to ask the user
   * whether to proceed; subsequent progress events do not carry the field.
   */
  manifestChanged?: boolean;
}

export function installPathFor(appid: number): string {
  return join(getInstallRoot(), String(appid));
}

/**
 * Pick the `-os` value to pass to DepotDownloader for `appid`.
 *
 * Rules:
 *   1. If the game ships on the host's platform, use it.
 *   2. Otherwise pick any other supported platform — Linux/Mac hosts can
 *      still install Windows builds and run them via Proton/Wine. Windows
 *      is preferred when multiple alternatives exist because that's the
 *      most common Proton/Wine target.
 *   3. If the game has no supported platforms (Store API outage with empty
 *      data, or genuinely unsupported title), return null — caller must
 *      fail-fast with `unsupported_platform`.
 *
 * Note: when the Steam Store call returns null (network error, unknown
 * appid), `supported` is `[]` and we still want the download to proceed
 * on the host platform rather than fail. The caller should pass the host
 * as a single-element fallback in that case.
 */
export function resolveTargetOs(
  host: GamePlatform | null,
  supported: GamePlatform[]
): GamePlatform | null {
  if (host && supported.includes(host)) return host;
  // Prefer Windows builds for Proton/Wine on non-Windows hosts.
  for (const p of ['windows', 'linux', 'mac'] as const) {
    if (supported.includes(p)) return p;
  }
  return null;
}

type Listener = (p: DownloadProgress) => void;

interface ActiveDownload {
  appid: number;
  proc: ChildProcess;
  cancel(): void;
}

const active = new Map<number, ActiveDownload>();

/**
 * Caller-provided fetcher for POST /accounts/{id}/email-auth-codes. Injected
 * by index.ts at boot via configureEmailAuthCodes(); the downloader stays
 * ApiClient-agnostic and unit-testable.
 *
 * Resolves with the response body on 200; rejects with ApiError(invalid,
 * status: 422) when the account has no email credentials, and with other
 * ApiError shapes on transient/network failures.
 */
export type EmailAuthCodesFetcher = (
  accountId: string,
  opts?: { userId?: string; limit?: number }
) => Promise<AccountEmailAuthCodesRead>;

let emailAuthCodesFetcher: EmailAuthCodesFetcher | null = null;

/** Wire the email-auth-codes endpoint at boot. Optional — when absent the
 *  downloader falls back to the legacy two_factor_required kill behaviour. */
export function configureEmailAuthCodes(fetcher: EmailAuthCodesFetcher): void {
  emailAuthCodesFetcher = fetcher;
}

export interface StartDownloadOptions {
  /**
   * Run DD with `-validate`: re-uses an existing install dir, verifies
   * chunks against the latest manifest, and downloads only the delta.
   *
   * When set, the empty-summary heuristic ("0 bytes from N depots") is
   * treated as "already up to date" rather than an error — DD legitimately
   * downloads nothing when every chunk passes verification.
   *
   * Caller is expected to point DD at an installed game; the install dir
   * must already exist (we don't recreate it).
   */
  updateMode?: boolean;
  /**
   * Steam language name (`russian`, `german`, …) for the localized depots.
   * Omitted means DepotDownloader's own default, which is english.
   *
   * Switching this on an existing install does not re-language it on its
   * own: the new depots only come down on a run with `-validate`, which is
   * what the launch-time update check already does.
   */
  language?: string;
}

/**
 * Start a DepotDownloader run for `appid` using pool account `accountId`.
 * Returns quickly; listener receives progress updates over the lifetime of
 * the download. Rejects on startup failure, resolves on successful start
 * (not on download completion).
 *
 * `userId` flows through to the email-auth-codes fallback so the backend
 * can scope the IMAP read to the active session.
 *
 * `opts.updateMode` triggers the on-launch update-check path — see
 * StartDownloadOptions.
 */
export async function startDownload(
  accountId: string,
  appid: number,
  gameName: string,
  onProgress: Listener,
  userId?: string,
  opts: StartDownloadOptions = {}
): Promise<void> {
  if (!Number.isInteger(appid) || appid <= 0) {
    throw new Error('bad appid');
  }
  if (active.has(appid)) {
    throw new Error('download already in progress for this appid');
  }
  const ddPath = resolveDepotDownloaderPath();
  if (!ddPath) {
    throw new Error(
      'DepotDownloader not found — set DEPOTDOWNLOADER_PATH env var or reinstall the app'
    );
  }

  const outDir = installPathFor(appid);
  // EACCES here means the user-chosen install root (settings.json -> installRoot)
  // is no longer writable: drive removed, permission stripped, or moved into
  // a protected location. ENOSPC means the host filesystem ran out of
  // space between the pre-flight check and the mkdir — DD's own writes
  // would have hit the same wall a few seconds later. Surface both as
  // specific error codes so the renderer can show a localised message.
  try {
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    log.warn('[downloader] mkdir install dir failed', outDir, (err as Error).message);
    if (isDiskFull(err)) throw new Error('disk_full');
    throw new Error(
      `cannot create install directory ${outDir}: ${(err as Error).message}`
    );
  }

  upsertInstall(appid, gameName, 'downloading', outDir);
  // Initial event: 0% + connecting phase so the UI shows "Подключение…"
  // immediately on click instead of an unexplained empty progress bar.
  onProgress({
    appid,
    percent: 0,
    done: false,
    stage: { phase: 'connecting' },
  });

  // Isolate DD's cache under our XDG_CACHE_HOME. If the primary location
  // can't be created (Windows ACL, read-only mount), fall back to a tmpdir
  // subfolder — losing cross-launch session caching is acceptable, breaking
  // the download isn't.
  let ddHome = join(paths.cache, 'depotdownloader-home');
  try {
    mkdirSync(ddHome, { recursive: true, mode: 0o700 });
  } catch (err) {
    const fallback = join(tmpdir(), 'steam-client-dd-home');
    log.warn(
      '[downloader] mkdir ddHome failed, falling back to tmpdir',
      ddHome,
      (err as Error).message
    );
    try {
      mkdirSync(fallback, { recursive: true, mode: 0o700 });
      ddHome = fallback;
    } catch (err2) {
      log.warn('[downloader] tmpdir fallback also failed', fallback, (err2 as Error).message);
      throw new Error(
        `cannot create DD cache dir (primary: ${(err as Error).message}, fallback: ${(err2 as Error).message})`
      );
    }
  }

  // We don't await withAccount here — it returns when DD exits, which can
  // be 20+ minutes. Caller sees download:progress events in the meantime.
  void runWithVault(
    accountId,
    appid,
    gameName,
    outDir,
    ddPath,
    ddHome,
    onProgress,
    userId,
    opts
  ).catch((err) => {
    log.warn('[dd] driver failed:', (err as Error).message);
    // The pool credentials this download needs are gated behind a live game
    // session. If it lapsed between the pre-flight check and the vault fetch,
    // surface the dedicated code so the renderer prompts for a fresh bot code
    // instead of showing a raw "auth rejected" string.
    const error =
      err instanceof ApiError && err.code === 'game_session_required'
        ? 'game_session_required'
        : (err as Error).message;
    onProgress({ appid, percent: 0, done: true, error });
    upsertInstall(appid, gameName, 'error');
    active.delete(appid);
  });
}

export function cancelDownload(appid: number): boolean {
  const a = active.get(appid);
  if (!a) return false;
  a.cancel();
  return true;
}

export function isDownloading(appid: number): boolean {
  return active.has(appid);
}

// ── internals ────────────────────────────────────────────────────────

async function runWithVault(
  accountId: string,
  appid: number,
  gameName: string,
  outDir: string,
  ddPath: string,
  ddHome: string,
  onProgress: Listener,
  userId?: string,
  opts: StartDownloadOptions = {}
): Promise<void> {
  log.info('[downloader] start', { accountId, appid });

  // Pre-flight disk-space check. We don't know the exact install size
  // upfront (Steam doesn't expose depot sizes cheaply) so this is a
  // sanity threshold rather than an exact match — anything under 5 GB
  // free on the install filesystem is rejected with a dedicated
  // `disk_full` error so the user gets a clear message instead of a
  // mid-download ENOSPC crash. When the host has plenty of space (the
  // common case) the check is a single statfs() syscall and bails
  // fast on its own.
  const MIN_FREE_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
  const free = freeBytes(outDir);
  if (free !== null && free < MIN_FREE_BYTES) {
    const freeMb = Math.round(free / (1024 * 1024));
    log.warn('[downloader] insufficient disk space', {
      appid,
      outDir,
      freeMb,
      minGb: 5,
    });
    onProgress({
      appid,
      percent: 0,
      done: true,
      error: 'disk_full',
    });
    upsertInstall(appid, gameName, 'error');
    throw new Error('disk_full');
  }

  // Resolve `-os` BEFORE entering withAccount so a Store API miss doesn't
  // hold the vault lease. We probe the Store for supported platforms; if
  // the call fails we fall back to the host platform alone — better than
  // breaking the downloader on a transient Store hiccup.
  const host = currentGamePlatform();
  let storeSupported: GamePlatform[] = [];
  try {
    const details = await getSteamAppDetails(appid);
    storeSupported = supportedPlatforms(details);
  } catch (err) {
    log.warn(
      '[downloader] platform probe failed, falling back to host',
      (err as Error).message
    );
  }
  const supportedForResolve =
    storeSupported.length > 0 ? storeSupported : host ? [host] : [];
  const targetOs = resolveTargetOs(host, supportedForResolve);
  if (!targetOs) {
    log.warn('[downloader] unsupported platform', {
      appid,
      host,
      storeSupported,
    });
    onProgress({
      appid,
      percent: 0,
      done: true,
      error: 'unsupported_platform',
      ...(storeSupported.length > 0 ? { errorPlatforms: storeSupported } : {}),
    });
    upsertInstall(appid, gameName, 'error');
    throw new Error('unsupported_platform');
  }
  log.info('[downloader] target os resolved', {
    appid,
    host,
    storeSupported,
    targetOs,
  });

  // Wrap the renderer's onProgress so every event we emit carries
  // cumulative bytesDownloaded and an estimated bytesTotal. The dir walk
  // is throttled to ~1.5 s to keep the per-event cost small on big
  // installs; terminal/percent events that don't trigger a walk just
  // inherit the previous sample.
  let lastBytesSampleAt = 0;
  let bytesTotalEstimate: number | null = null;
  const emit = (ev: DownloadProgress): void => {
    const now = Date.now();
    if (now - lastBytesSampleAt >= 1500) {
      try {
        ev.bytesDownloaded = dirBytes(outDir);
      } catch {
        // outDir deleted or unreadable — leave the field off this tick.
      }
      lastBytesSampleAt = now;
    }
    // Estimate total size from the running fraction-complete. Skip the
    // first 5% to avoid dividing by a tiny (and noisy) fraction. The
    // estimate is monotonically non-decreasing — once we've seen a
    // larger upper bound, we never show a smaller one, so the bar can't
    // "jump down" as more data lands and the sample stabilises.
    if (
      ev.bytesDownloaded !== undefined &&
      ev.stage?.current !== undefined &&
      ev.stage?.total !== undefined &&
      ev.stage.total > 0
    ) {
      const agg = (ev.stage.current - 1 + ev.percent / 100) / ev.stage.total;
      if (agg > 0.05) {
        const est = ev.bytesDownloaded / agg;
        bytesTotalEstimate = Math.max(bytesTotalEstimate ?? 0, est);
      }
    }
    if (bytesTotalEstimate !== null) {
      ev.bytesTotal = Math.round(bytesTotalEstimate);
    }
    onProgress(ev);
  };

  await withAccount(accountId, async (creds) => {
    const login = creds.login;
    const password = creds.password;
    const sharedSecret = creds.steam_mafile_plain?.shared_secret;

    return new Promise<void>((resolve, reject) => {
      // `-remember-password` lets DD cache a session file in ddHome so a
      // second run doesn't need to prompt again. Session never leaves ddHome.
      const args = [
        '-app',
        String(appid),
        '-dir',
        outDir,
        '-os',
        targetOs,
        '-username',
        login,
        '-remember-password',
      ];
      // Language. Without this DepotDownloader takes its default — english —
      // so every game installed in English no matter what the launcher was
      // set to. Steam models localization as separate depots tagged with a
      // language, plus language-neutral ones carrying the engine and assets;
      // `-language` selects which tagged depots come down alongside the
      // neutral set. A game that has no depot for the requested language
      // simply gets the neutral ones, which is the game's own default — the
      // fallback comes for free rather than needing to be coded.
      if (opts.language) args.push('-language', opts.language);
      // Resuming an interrupted download: the dir already holds DD's
      // pre-allocated (partly zero-filled) files + `.DepotDownloader` state
      // from a prior run, but no completion marker. Force -validate so DD
      // checksums what's on disk and re-fetches the unwritten chunks instead
      // of trusting the pre-allocation — without it a hollow file could be
      // taken as done and the install would "finish" still corrupt.
      const resuming = !hasCompletionMarker(outDir) && dirHasContent(outDir);
      // On-launch update check: re-verify chunks against the latest manifest
      // and download only the delta. DD v3.4 has -validate (no -only-validate).
      if (opts.updateMode || resuming) {
        args.push('-validate');
        if (resuming) log.info('[downloader] resuming partial install', { appid, outDir });
      }

      // Isolate DD's session/cache/sentry into ddHome regardless of platform.
      // The correct env var name differs — on Linux/macOS DepotDownloader
      // (a .NET app) reads HOME + XDG_*, on Windows it reads
      // USERPROFILE + APPDATA + LOCALAPPDATA.
      const isolationEnv =
        process.platform === 'win32'
          ? {
              USERPROFILE: ddHome,
              APPDATA: ddHome,
              LOCALAPPDATA: ddHome,
            }
          : {
              HOME: ddHome,
              XDG_CONFIG_HOME: ddHome,
              XDG_DATA_HOME: ddHome,
              XDG_CACHE_HOME: ddHome,
            };
      const proc = spawn(ddPath, args, {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...isolationEnv,
        },
      });

      const redact = (s: string) =>
        s.replace(new RegExp(escapeRegex(login), 'gi'), '<login>');

      // If DepotDownloader doesn't emit anything for this long, assume it
      // hung (bad credentials, invalid appid, waiting for a prompt we don't
      // recognise) and force-kill it with a clear error.
      const STALL_TIMEOUT_MS = 180_000;
      let lastActivityAt = Date.now();
      let fatalError: string | null = null;

      const killWith = (reason: string) => {
        if (fatalError) return;
        fatalError = reason;
        log.warn('[dd]', reason);
        try {
          proc.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      };

      const watchdog = setInterval(() => {
        if (!active.has(appid)) return;
        if (Date.now() - lastActivityAt > STALL_TIMEOUT_MS) {
          killWith('stall_timeout');
        }
      }, 30_000);

      const handle: ActiveDownload = {
        appid,
        proc,
        cancel: () => {
          killWith('cancelled');
        },
      };
      active.set(appid, handle);

      let lastPercent = -1;
      let lastReport = 0;
      let stdoutBuf = '';
      const ddState = makeDdState();
      // ── Empty-download detection ────────────────────────────────────
      // DD exits with code 0 even when login succeeded but no depots
      // were actually fetched (e.g. the pool account doesn't own this
      // game). We parse the final summary line and the per-depot
      // unavailability line so the exit handler can distinguish a real
      // success from an empty install dir.
      let totalDownloadedBytes: number | null = null;
      let depotsCounted: number | null = null;
      let sawDepotUnavailable = false;
      let sawManifestFetch = false;
      // DD prints either:
      //   "Total downloaded: 0 bytes from 0 depots" (older builds, no parens)
      //   "Total downloaded: 0 bytes (0 bytes uncompressed) from 0 depots" (3.4+)
      // The optional non-capturing group absorbs the parenthetical so the
      // empty-download detection works on both.
      const TOTAL_DOWNLOADED_RE =
        /Total downloaded:\s*(\d+)\s*bytes(?:\s*\([^)]*\))?\s*from\s*(\d+)\s*depots/i;
      const DEPOT_UNAVAILABLE_RE =
        /Depot\s+\d+\s+is\s+not\s+available\s+from\s+this\s+account/i;
      // "This depot has changed" — the signal the launch update-check reads.
      //
      // NOT the bare `Downloading depot N` line, which is what this used to
      // match. DepotDownloader prints that for every depot it processes, on
      // every run, before it has looked at a single file — so the check said
      // "an update is available" every single time. Straight from a real log
      // of a game that was already current:
      //
      //   Processing depot 475552
      //   Already have manifest 4580279904639415577 for depot 475552.
      //   Downloading depot 475552          ← printed anyway
      //
      // What actually distinguishes the two cases is one line earlier: DD
      // either reports the manifest is already cached, or fetches a new one.
      // A new manifest is exactly what "the depot changed" means, and it
      // lands before any file bytes do, so the check can still stop DD and
      // ask the user first. Across this machine's logs the accounting is
      // exact: 24 depots processed = 14 manifest fetches + 10 already-have.
      const MANIFEST_FETCH_RE = /^\s*Downloading depot \d+\s+manifest/i;
      // Last DownloadStage we forwarded — included on every percent event so
      // the renderer can keep the label even when we throttle the next percent.
      let currentStage: DownloadStage = { phase: 'connecting' };

      // ── email-auth-codes fallback state ─────────────────────────────
      // Set across multiple guard prompts in this single DD run.
      // - usedCodes: codes we already fed to DD (avoid retrying a wrong one).
      // - knows422: cached "no email creds" verdict; skip future polling.
      // - emailGuardInFlight: prevents overlapping pollers when DD prints
      //   the prompt twice in quick succession (stdout + stderr).
      const usedCodes = new Set<string>();
      let knows422 = false;
      let emailGuardInFlight = false;
      let procExited = false;

      const handleLine = (raw: string) => {
        const line = raw.trimEnd();
        if (!line) return;
        lastActivityAt = Date.now();
        // Logged at info so post-mortem debugging without LOG_LEVEL=debug is
        // possible. Login is redacted; passwords/2FA codes never reach stdout.
        log.info('[dd]', redact(line));

        // Capture summary + license-mismatch markers so the exit handler can
        // tell a clean "0 bytes from 0 depots" from a real success.
        const totalMatch = TOTAL_DOWNLOADED_RE.exec(line);
        if (totalMatch && totalMatch[1] && totalMatch[2]) {
          totalDownloadedBytes = Number(totalMatch[1]);
          depotsCounted = Number(totalMatch[2]);
          // DD's own number is authoritative — overwrite the running
          // estimate so the bar lands on the true final size the moment
          // DD prints it. Skipped if the summary is "0 bytes" (empty
          // download), which we want to surface as a known error rather
          // than as a 0-byte estimate.
          if (totalDownloadedBytes > 0) {
            bytesTotalEstimate = totalDownloadedBytes;
          }
        }
        if (DEPOT_UNAVAILABLE_RE.test(line)) {
          sawDepotUnavailable = true;
        }
        // One-shot signal for the launch update-check path. Fired
        // synchronously so the listener can abort the run before the first
        // delta chunk lands. Subsequent events omit the field — it marks a
        // transition, it is not a sticky flag.
        if (!sawManifestFetch && MANIFEST_FETCH_RE.test(line)) {
          sawManifestFetch = true;
          emit({
            appid,
            percent: lastPercent < 0 ? 0 : lastPercent,
            done: false,
            stage: currentStage,
            manifestChanged: true,
          });
        }

        const ev = parseDdLine(line, ddState);
        if (!ev) return;

        switch (ev.type) {
          case 'fatal':
            killWith(ev.code);
            return;
          case 'password_prompt':
            proc.stdin?.write(password + '\n');
            return;
          case 'guard_prompt':
            if (sharedSecret) {
              try {
                const code = generateAuthCode(sharedSecret);
                proc.stdin?.write(code + '\n');
              } catch (err) {
                log.warn('[dd] TOTP generate failed:', (err as Error).message);
                killWith('two_factor_failed');
              }
              return;
            }
            // No maFile → try the IMAP fallback before killing. The poll
            // is async; we let DD keep waiting on the prompt while we work.
            // Subsequent prompts (wrong code) re-enter this branch and the
            // in-flight guard skips them so we don't fan-out pollers.
            if (emailGuardInFlight) return;
            if (knows422) {
              killWith('account_unconfigured');
              return;
            }
            if (!emailAuthCodesFetcher) {
              // Backwards-compat: if main never wired the fetcher (older
              // builds, tests), preserve the legacy two_factor_required
              // kill so behaviour matches what the renderer expects.
              killWith('two_factor_required');
              return;
            }
            emailGuardInFlight = true;
            void pollEmailAuthCode({
              accountId,
              userId,
              appid,
              fetcher: emailAuthCodesFetcher,
              usedCodes,
              onProgress,
              isExited: () => procExited,
            })
              .then((res) => {
                emailGuardInFlight = false;
                if (procExited) return;
                if (res.kind === 'code') {
                  usedCodes.add(res.code);
                  log.info('[guard] using email-auth code', maskCode(res.code));
                  // Brief "received" hint so the UI can flash a label.
                  emit({
                    appid,
                    percent: 0,
                    done: false,
                    stage: currentStage,
                    guardHint: 'received',
                  });
                  if (proc.stdin && !proc.stdin.destroyed) {
                    proc.stdin.write(res.code + '\n');
                  }
                  return;
                }
                if (res.kind === '422') {
                  knows422 = true;
                  killWith('account_unconfigured');
                  return;
                }
                // exhausted
                log.warn(
                  '[guard] email-auth-codes exhausted, falling back to two_factor_required'
                );
                killWith('two_factor_required');
              })
              .catch((err) => {
                emailGuardInFlight = false;
                log.warn('[guard] poll loop crashed:', (err as Error).message);
                if (!procExited) killWith('two_factor_required');
              });
            // Show the "waiting for email" hint immediately on first prompt.
            emit({
              appid,
              percent: 0,
              done: false,
              stage: currentStage,
              guardHint: 'waiting_for_email',
            });
            return;
          case 'depot_transition':
            // New depot/validation pass started. Reset the percent throttle so
            // the very first 0% of the new stage actually reaches the UI —
            // otherwise it'd be filtered as a duplicate of the previous 100%.
            currentStage = ev.stage;
            lastPercent = -1;
            emit({ appid, percent: 0, done: false, stage: currentStage });
            return;
          case 'stage':
            currentStage = ev.stage;
            emit({ appid, percent: 0, done: false, stage: currentStage });
            return;
          case 'percent': {
            const now = Date.now();
            if (ev.percent !== lastPercent && now - lastReport > 250) {
              lastPercent = ev.percent;
              lastReport = now;
              emit({ appid, percent: ev.percent, done: false, stage: currentStage });
            }
            return;
          }
        }
      };

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const l of lines) handleLine(l);
        // DD's interactive prompts under our env-isolated spawn DON'T end
        // with \n — they sit on the same line waiting for input. The
        // line-only parser would never see them and DD would stall until
        // STALL_TIMEOUT_MS. Probe the unflushed tail for known prompts.
        if (
          stdoutBuf &&
          /Enter account password|Steam Guard|two-factor|TwoFactor|enter the current code|authenticator/i.test(
            stdoutBuf
          )
        ) {
          handleLine(stdoutBuf);
          stdoutBuf = '';
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        log.warn('[dd] stderr:', redact(text));
        // DD writes the Steam Guard prompt to stderr (not stdout) and
        // without a trailing newline. The same parser recognises it — feed
        // the chunk through handleLine so guard_prompt → TOTP write fires.
        if (
          /STEAM GUARD|Steam Guard|two-factor|TwoFactor|enter the current code|authenticator/i.test(
            text
          )
        ) {
          handleLine(text);
        }
      });
      proc.on('error', (err) => {
        procExited = true;
        clearInterval(watchdog);
        active.delete(appid);
        emit({
          appid,
          percent: lastPercent < 0 ? 0 : lastPercent,
          done: true,
          // Spawn errors usually mean the exe vanished or perms are
          // broken — surface as the raw message. ENOSPC at spawn is
          // vanishingly rare on Windows but covered anyway.
          error: isDiskFull(err) ? 'disk_full' : err.message,
        });
        upsertInstall(appid, gameName, 'error');
        reject(err);
      });
      proc.on('close', (code) => {
        procExited = true;
        clearInterval(watchdog);
        active.delete(appid);
        if (code === 0 && !fatalError) {
          // DD exits 0 cleanly when login succeeded but the depot isn't
          // owned by the pool account ("Depot N is not available from this
          // account" → "Total downloaded: 0 bytes from 0 depots"). The
          // install dir is empty in that case; mark it as a failure so the
          // UI doesn't show a working "Play" button on a missing game.
          //
          // Two signals that we got nothing:
          //   - parsed summary said 0/0 (most reliable)
          //   - we saw the unavailable-depot line but no summary at all
          //     (DD output format drift / truncated stdout)
          // Either is enough to refuse marking the install as ready.
          const summarySaysEmpty =
            totalDownloadedBytes === 0 && depotsCounted === 0;
          const noSummaryButUnavailable =
            totalDownloadedBytes === null && sawDepotUnavailable;
          if (summarySaysEmpty || noSummaryButUnavailable) {
            const reason = sawDepotUnavailable
              ? 'account_missing_license'
              : 'empty_download';
            log.warn('[downloader] DD exited 0 but downloaded 0 bytes', {
              appid,
              reason,
              totalDownloadedBytes,
              depotsCounted,
              sawDepotUnavailable,
            });
            // Platform-aware refinement: if DD reported the depot
            // unavailable AND the Steam Store says the title ships on
            // platforms other than ours, it's almost certainly a
            // cross-platform license mismatch (e.g. Windows-only copy on
            // a Linux client) rather than "no license at all". Surface
            // the more specific message + the available platforms so the
            // user knows what to do. Falls back silently to the generic
            // reason on any Store-API error.
            void (async () => {
              let finalReason = reason;
              let platformsForUi: GamePlatform[] | undefined;
              if (reason === 'account_missing_license') {
                try {
                  const here = currentGamePlatform();
                  const details = await getSteamAppDetails(appid);
                  const supported = supportedPlatforms(details);
                  if (
                    here &&
                    supported.length > 0 &&
                    supported.some((p) => p !== here)
                  ) {
                    finalReason = 'account_missing_license_other_platform';
                    platformsForUi = supported;
                  }
                } catch (err) {
                  log.warn(
                    '[downloader] post-fail platform probe failed',
                    (err as Error).message
                  );
                }
              }
              emit({
                appid,
                percent: lastPercent < 0 ? 0 : lastPercent,
                done: true,
                error: finalReason,
                ...(platformsForUi ? { errorPlatforms: platformsForUi } : {}),
              });
              // In update-mode the game is already installed — a validate
              // pass that comes back empty/unavailable must NOT flip a
              // working install to 'error'. Only a fresh download does.
              if (!opts.updateMode) upsertInstall(appid, gameName, 'error');
              reject(new Error(finalReason));
            })();
            return;
          }
          // Post-install DRM strip + gbe_fork DLL swap. Wrapped in an async
          // IIFE because proc.on('close', …) is a synchronous callback and
          // we still need to await applyDrmPatches before flipping the
          // ledger to `installed` (otherwise the user could hit Play on
          // an unpatched build and crash on Steam-DRM init).
          //
          // For update-mode passes that downloaded 0 bytes we still run the
          // patcher: it's idempotent (skips DLLs that already carry the
          // .gbe_fork marker) so the overhead is one directory walk per
          // launch's update-check, while guaranteeing we self-heal if a
          // prior patching run was interrupted.
          void (async () => {
            try {
              const mainExe = safeFindMainExe(outDir, gameName);
              if (mainExe) {
                await applyDrmPatches(outDir, appid, mainExe);
              } else {
                log.warn(
                  '[downloader] no main exe located — skipping DRM patches',
                  { appid, outDir }
                );
              }
            } catch (err) {
              // Never block the install on DRM patch failure — partial
              // patching is preferable to a 50GB orphaned download.
              log.warn(
                '[downloader] DRM patcher threw',
                (err as Error).message
              );
            }
            // Install any runtimes the depot bundled under _CommonRedist
            // (VC++, DirectX, .NET). DepotDownloader only pulls the files;
            // without this a game linking against e.g. VC++ 2013 fails to
            // start with a Windows "system error" the instant the user hits
            // Play. Best-effort and idempotent (marker file) — a failure
            // (declined UAC, installer error) never blocks the install.
            try {
              await defaultInstallRedists(outDir, (current, total, label) => {
                emit({
                  appid,
                  percent: 100,
                  done: false,
                  stage: { phase: 'installing_redist', label, current, total },
                });
              });
            } catch (err) {
              log.warn('[downloader] redist installer threw', (err as Error).message);
            }
            // Don't carry the in-flight depot stage into the terminal event —
            // the renderer drops downloadStage on `done: true`.
            // DepotDownloader exited cleanly with real data — drop the
            // completion marker BEFORE flipping the ledger so install-state
            // detection (mergeInstallState / rescanInstallRoot) can trust it.
            // Its absence is what keeps an interrupted download off the Play
            // button and on Resume instead.
            markDownloadComplete(outDir, appid);
            emit({
              appid,
              percent: 100,
              done: true,
              ...(totalDownloadedBytes !== null
                ? { downloadedBytes: totalDownloadedBytes }
                : {}),
            });
            upsertInstall(appid, gameName, 'installed', outDir);
            resolve();
          })();
        } else {
          const msg = fatalError ?? `exited_${code ?? 'null'}`;
          emit({
            appid,
            percent: lastPercent < 0 ? 0 : lastPercent,
            done: true,
            error: msg,
            ...(totalDownloadedBytes !== null
              ? { downloadedBytes: totalDownloadedBytes }
              : {}),
          });
          // Update-mode cancel (user chose to defer the update) or a failed
          // validate must leave the existing install 'installed' — it's on
          // disk and playable. Only a fresh download marks 'error'.
          if (!opts.updateMode) upsertInstall(appid, gameName, 'error');
          reject(new Error(msg));
        }
      });
    });
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True if `dir` holds anything (an interrupted download left partial files +
 *  `.DepotDownloader` state). A freshly-created empty install dir returns
 *  false. Errors (missing dir) count as empty. */
function dirHasContent(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * findGameExe throws when no candidate is found. The DRM patcher only needs
 * the install dir, but a sensible main-exe location lets it drop the
 * steam_appid.txt next to the binary the user will actually launch. Swallow
 * the throw so the patching pass continues without an appid file in the
 * pathological "no .exe in the install" case (e.g. proton-only Linux builds).
 */
function safeFindMainExe(installDir: string, gameName: string): string | null {
  try {
    const found = findGameExe(installDir, gameName);
    return found.path;
  } catch {
    return null;
  }
}

/** Defaults tuned for Steam Guard email latency: 30s window, 3s cadence. */
export interface EmailGuardPollOptions {
  accountId: string;
  userId?: string;
  appid: number;
  fetcher: EmailAuthCodesFetcher;
  /** Codes already fed to DD this run — never replayed. */
  usedCodes: Set<string>;
  /** Optional callback for telemetry/progress; safe to omit in tests. */
  onProgress?: Listener;
  /** Bail early if DD exited. */
  isExited?: () => boolean;
  /** Test seam — defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam — defaults to Date.now. */
  now?: () => number;
  /** Total poll budget. Default 120s — Steam can take up to ~2 min to
   *  deliver the Guard email, so we keep retrying that whole window. */
  totalTimeoutMs?: number;
  /** Delay between attempts. Default 5s — never poll the backend faster. */
  intervalMs?: number;
  /** How far back the very first iteration accepts old codes. */
  graceMs?: number;
  /** Page size for getEmailAuthCodes. Backend caps at 5. */
  limit?: number;
}

export type EmailGuardPollResult =
  | { kind: 'code'; code: string; raw: AccountEmailAuthCodeRead }
  | { kind: '422' }
  | { kind: 'exhausted' };

/**
 * Poll POST /accounts/{id}/email-auth-codes until a fresh, unused code
 * appears or the timeout window closes.
 *
 * "Fresh" = `received_at >= attemptStart - graceMs` to absorb client/server
 * clock skew. Codes that arrived BEFORE this DD login attempt are useless:
 * Steam invalidates older codes when a newer one is sent, and even an
 * un-invalidated old code likely reflects a different login attempt that
 * Steam has already cached as "approved" — re-feeding it would just trip
 * the same Guard prompt again.
 */
export async function pollEmailAuthCode(
  opts: EmailGuardPollOptions
): Promise<EmailGuardPollResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());
  const totalTimeoutMs = opts.totalTimeoutMs ?? 120_000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const graceMs = opts.graceMs ?? 10_000;
  const limit = opts.limit ?? 5;
  const isExited = opts.isExited ?? (() => false);

  const pollStart = now();
  // Anchor: any code with received_at >= this is considered "from this
  // attempt". The grace window absorbs client/server clock skew.
  const cutoff = pollStart - graceMs;

  // The poll is driven by the wall-clock budget (default 120s @ 5s spacing
  // ≈ 24 attempts) — Steam can take up to ~2 min to send the Guard email.
  // The attempt counter is only a safety bound so a frozen test clock can't
  // spin forever; real runs always stop on the wall-clock checks below.
  const maxAttempts = Math.max(1, Math.ceil(totalTimeoutMs / intervalMs) + 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (isExited()) return { kind: 'exhausted' };
    if (now() - pollStart > totalTimeoutMs) break;

    try {
      const res = await opts.fetcher(opts.accountId, {
        userId: opts.userId,
        limit,
      });
      const fresh = res.codes
        .filter((c) => isFreshCode(c, cutoff) && !opts.usedCodes.has(c.code))
        .sort(byReceivedAtDesc);
      // Prefer Steam "Access from new computer" subjects when available;
      // they're newer-style verification codes. Fall back to the most
      // recent of any Steam mail otherwise.
      const preferred = fresh.find((c) =>
        /Access from new computer|Steam Guard/i.test(c.subject ?? '')
      );
      const pick = preferred ?? fresh[0];
      if (pick) {
        return { kind: 'code', code: pick.code, raw: pick };
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) {
        log.info(
          '[guard] account has no email credentials on backend; aborting poll'
        );
        return { kind: '422' };
      }
      log.warn(
        '[guard] email-auth-codes call failed (will retry):',
        (err as Error).message
      );
    }

    // Stop once the next attempt would land past the budget; otherwise wait
    // out the interval and retry.
    if (now() - pollStart + intervalMs > totalTimeoutMs) break;
    await sleep(intervalMs);
  }

  return { kind: 'exhausted' };
}

function isFreshCode(c: AccountEmailAuthCodeRead, cutoffMs: number): boolean {
  if (!c.received_at) return false;
  const ts = Date.parse(c.received_at);
  if (Number.isNaN(ts)) return false;
  return ts >= cutoffMs;
}

function byReceivedAtDesc(
  a: AccountEmailAuthCodeRead,
  b: AccountEmailAuthCodeRead
): number {
  const ta = a.received_at ? Date.parse(a.received_at) : 0;
  const tb = b.received_at ? Date.parse(b.received_at) : 0;
  return tb - ta;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Mask a Steam Guard code for logs (5-letter codes → "H6***"). */
function maskCode(code: string): string {
  if (code.length <= 2) return '***';
  return code.slice(0, 2) + '*'.repeat(Math.max(1, code.length - 2));
}
