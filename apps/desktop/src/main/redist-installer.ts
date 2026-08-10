/**
 * Post-install redistributable runner.
 *
 * Steam depots ship the C/C++ runtimes, DirectX, and .NET a game needs in
 * a `_CommonRedist/` tree, and the real Steam client silently runs them
 * on first install. DepotDownloader only pulls the files — it never runs
 * the installers — so a freshly "installed" game that links against, say,
 * VC++ 2013 (msvcr120.dll) fails to even start with a Windows "system
 * error" the moment the user hits Play. This module closes that gap: it
 * finds the bundled installers and runs them silently once per install.
 *
 * Windows-only. On Linux/Mac hosts (installing Windows builds for
 * Proton/Wine) the .exe installers are meaningless — Proton provides the
 * runtimes itself — so we no-op.
 *
 * Elevation: the VC++/DirectX/.NET installers carry a
 * requireAdministrator manifest, so a non-elevated process can't
 * CreateProcess them directly (ERROR_ELEVATION_REQUIRED). We run the
 * whole set through a single elevated batch (one UAC prompt for all of
 * them) instead of one prompt per installer.
 *
 * Idempotent: a `.redists_done` marker is written in the install dir on
 * completion so the per-launch update-check (which re-enters the download
 * pipeline with -validate) doesn't re-prompt for UAC every time.
 */
import { basename, join } from 'node:path';
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import log from 'electron-log/main.js';
import { parseVdf, extractRunProcesses } from './installscript';

export interface RedistItem {
  /** Absolute path to the installer — usually a .exe, but installscript
   *  sometimes points at a .cmd wrapper (e.g. VC++ 2022, .NET 4.7). */
  path: string;
  /** Human-readable tag for logs — the installscript block name
   *  ("x64 12.0.30501") or a classified label ("vcredist 2013 x86"). */
  label: string;
  /** Silent-install arguments (from installscript's `command N`, or the
   *  classified silent flags in the filename fallback). */
  args: string[];
}

/**
 * Classify a single `_CommonRedist` installer path into the silent-install
 * invocation for its family, or null if we don't recognise it (we only run
 * installers whose silent flags we know — never guess and pop a UI).
 *
 * Pure: path-string in, descriptor out. This is the unit-tested core.
 */
export function classifyRedist(path: string): RedistItem | null {
  const lower = path.toLowerCase().replace(/\\/g, '/');
  const name = basename(lower);
  const arch = lower.includes('x64')
    ? 'x64'
    : lower.includes('x86') || lower.includes('x32')
      ? 'x86'
      : '';

  // ── Visual C++ runtimes: vcredist_x{86,64}.exe under vcredist/<year>/ ──
  if (name.startsWith('vcredist')) {
    const year = /vcredist\/(\d{4})\//.exec(lower)?.[1] ?? '';
    const label = `vcredist ${year || '?'} ${arch}`.trim();
    // 2005/2008 use InstallShield (/q). 2010 is a standalone MSI wrapper
    // (/passive /norestart). 2012 and later are WiX bundles
    // (/install /quiet /norestart). Default to the modern WiX flags —
    // that's what the vast majority of shipping depots carry.
    if (year === '2005' || year === '2008') return { path, label, args: ['/q'] };
    if (year === '2010') return { path, label, args: ['/passive', '/norestart'] };
    return { path, label, args: ['/install', '/quiet', '/norestart'] };
  }

  // ── DirectX end-user runtime: DXSETUP.exe under DirectX/ ──
  if (name === 'dxsetup.exe') {
    return { path, label: 'DirectX runtime', args: ['/silent'] };
  }

  // ── .NET Framework web/offline installers: NDP*.exe under DotNet/ ──
  if (name.startsWith('ndp') && name.endsWith('.exe')) {
    const ver = /dotnet\/([^/]+)\//.exec(lower)?.[1] ?? '';
    return { path, label: `.NET ${ver}`.trim(), args: ['/q', '/norestart'] };
  }

  return null;
}

/**
 * Steam ships some redists as a `.cmd`/`.bat` wrapper around the real
 * installer, uniformly shaped as:
 *
 *   start /w "" "%~dp0\<installer>" <silent flags>
 *
 * i.e. the wrapper just launches a sibling installer with silent flags. We
 * prefer to run that installer directly, because a couple of Valve's own
 * wrappers ship with a typo that drops the `.exe` from the target —
 * "Microsoft Visual C++ 2015 x86.cmd" references `vc_redist.x86`, not
 * `vc_redist.x86.exe`, so `start` can't find the file and the x86 runtime
 * silently never installs (its vcruntime140/msvcp140 DLLs go missing).
 * Reading the wrapper lets us repair that (probe `<target>.exe` when the
 * literal target is absent) and sidesteps the fragile call-a-cmd path.
 *
 * Returns the resolved installer + argv, or null when the wrapper doesn't
 * match the expected shape or the target can't be found on disk — the caller
 * then runs the wrapper as-is (unchanged behaviour for anything exotic).
 */
export function unwrapCmdInstaller(
  wrapperPath: string,
  text: string,
  exists: (p: string) => boolean
): { process: string; args: string[] } | null {
  // Capture the %~dp0-relative target (up to the closing quote) and whatever
  // trailing flags sit on that line.
  const m = /%~dp0[\\/]+([^"\r\n]+?)"\s*([^\r\n]*)/i.exec(text);
  if (!m) return null;
  const cut = Math.max(wrapperPath.lastIndexOf('\\'), wrapperPath.lastIndexOf('/'));
  if (cut < 0) return null;
  const dir = wrapperPath.slice(0, cut);
  const sep = wrapperPath.includes('\\') ? '\\' : '/';
  const target = m[1].trim();
  let full = `${dir}${sep}${target}`;
  // Repair Valve's missing-extension typo: the literal target is absent but a
  // sibling `<target>.exe` is on disk.
  if (!exists(full) && exists(`${full}.exe`)) full = `${full}.exe`;
  if (!exists(full)) return null;
  const flags = m[2].trim();
  return {
    process: full,
    args: flags ? flags.split(/\s+/).filter((s) => s.length > 0) : [],
  };
}

export interface ScanDeps {
  /** List entries of a directory; return [] on any error. */
  readDir: (dir: string) => Array<{ name: string; isDir: boolean }>;
  /** Read a text file (installscript.vdf); null on any error. */
  readFile: (path: string) => string | null;
  /** True when a path exists on disk (installer .exe presence check). */
  exists: (path: string) => boolean;
  join: (...parts: string[]) => string;
  /** Host is 64-bit Windows — gates x64-only installscript entries. */
  is64BitWindows: boolean;
}

/**
 * Find every runtime a game wants installed, preferring Steam's own
 * `installscript.vdf` (authoritative: exact process, exact silent command,
 * OS gate) and falling back to filename classification only when no
 * installscript yields a runnable process.
 *
 * Walks `<installDir>/_CommonRedist` (Steam) / `CommonRedist` (older
 * repacks). Depth-limited to the canonical
 * `_CommonRedist/<family>/<version>/` layout.
 */
export function scanRedists(installDir: string, deps: ScanDeps): RedistItem[] {
  const root = deps
    .readDir(installDir)
    .find(
      (e) =>
        e.isDir &&
        (e.name.toLowerCase() === '_commonredist' ||
          e.name.toLowerCase() === 'commonredist')
    );
  if (!root) return [];
  const redistRoot = deps.join(installDir, root.name);

  const scripts: string[] = [];
  const exes: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4) return;
    for (const e of deps.readDir(dir)) {
      const full = deps.join(dir, e.name);
      if (e.isDir) {
        walk(full, depth + 1);
      } else if (e.name.toLowerCase() === 'installscript.vdf') {
        scripts.push(full);
      } else if (e.name.toLowerCase().endsWith('.exe')) {
        exes.push(full);
      }
    }
  };
  walk(redistRoot, 0);

  // ── Authoritative path: parse each installscript.vdf ──
  const found: RedistItem[] = [];
  const seen = new Set<string>();
  for (const scriptPath of scripts) {
    const text = deps.readFile(scriptPath);
    if (!text) continue;
    let procs;
    try {
      procs = extractRunProcesses(parseVdf(text), installDir, deps.is64BitWindows);
    } catch (err) {
      log.warn('[redist] installscript parse failed', {
        scriptPath,
        err: (err as Error).message,
      });
      continue;
    }
    for (const p of procs) {
      let process = p.process;
      let args = p.args;
      // Unwrap .cmd/.bat installer wrappers to run the real installer
      // directly (repairs Valve's missing-.exe typo; see unwrapCmdInstaller).
      // Fall back to the wrapper as-is when it doesn't parse.
      if (/\.(cmd|bat)$/i.test(process)) {
        const text = deps.readFile(process);
        const unwrapped = text ? unwrapCmdInstaller(process, text, deps.exists) : null;
        if (unwrapped) {
          process = unwrapped.process;
          args = unwrapped.args;
        }
      }
      const key = process.toLowerCase();
      if (seen.has(key) || !deps.exists(process)) continue;
      seen.add(key);
      found.push({ path: process, label: p.name, args });
    }
  }
  if (found.length > 0) return found;

  // ── Fallback: no usable installscript — classify by filename. ──
  const byName: RedistItem[] = [];
  for (const exe of exes) {
    const item = classifyRedist(exe);
    if (item) byName.push(item);
  }
  const rank = (l: string) =>
    l.startsWith('vcredist') ? 0 : l.startsWith('DirectX') ? 1 : 2;
  byName.sort((a, b) => rank(a.label) - rank(b.label) || a.path.localeCompare(b.path));
  return byName;
}

/** Progress callback: package `current` of `total` (`label`) is starting. */
export type RedistProgress = (current: number, total: number, label: string) => void;

export interface InstallDeps {
  scan: (installDir: string) => RedistItem[];
  pathExists: (p: string) => boolean;
  writeMarker: (p: string) => void;
  markerPath: (installDir: string) => string;
  /** Run all installers elevated (single UAC). `onProgress` fires as each
   *  package starts. Rejects on hard failure. */
  runElevated: (items: RedistItem[], onProgress?: RedistProgress) => Promise<void>;
  platform: NodeJS.Platform;
}

export type RedistResult =
  | { ran: true; count: number }
  | { ran: false; reason: 'platform' | 'already_done' | 'none_found' | 'error' };

/**
 * Install every recognised redistributable bundled with the game, once.
 * Best-effort: a failure (user declined UAC, an installer errored) is
 * logged and swallowed — the game is still "installed", it just may need
 * the runtime installed manually. Never throws.
 *
 * `onProgress` reports which package is being installed so the caller can
 * surface an "Installing package N of M" step in the UI.
 */
export async function installRedists(
  installDir: string,
  deps: InstallDeps,
  onProgress?: RedistProgress
): Promise<RedistResult> {
  if (deps.platform !== 'win32') return { ran: false, reason: 'platform' };
  const marker = deps.markerPath(installDir);
  if (deps.pathExists(marker)) return { ran: false, reason: 'already_done' };

  const items = deps.scan(installDir);
  if (items.length === 0) {
    // Nothing to do — still drop the marker so we don't rescan every launch.
    deps.writeMarker(marker);
    return { ran: false, reason: 'none_found' };
  }

  log.info('[redist] installing bundled runtimes', {
    installDir,
    items: items.map((i) => i.label),
  });
  try {
    await deps.runElevated(items, onProgress);
    deps.writeMarker(marker);
    log.info('[redist] done', { count: items.length });
    return { ran: true, count: items.length };
  } catch (err) {
    // Don't write the marker on failure — a later launch retries. But do
    // not block the install: a missing runtime is recoverable, a wiped
    // download is not.
    log.warn('[redist] install failed (continuing)', (err as Error).message);
    return { ran: false, reason: 'error' };
  }
}

// ── Production wiring ─────────────────────────────────────────────────────

const MARKER_NAME = '.redists_done';

// Upper bound on the elevated batch. A broken or interactive installer (e.g.
// a wrapper whose target is missing, popping a hidden "cannot find file"
// dialog) would otherwise block -Wait forever and wedge the whole download at
// "Installing dependencies". Redists are best-effort, so on timeout we give
// up — and retry on the next launch — rather than hang the pipeline. Generous
// enough for a slow UAC response plus DirectX/VC++/.NET on a spinning disk.
const REDIST_BATCH_TIMEOUT_MS = 10 * 60_000;

function realScanDeps(): ScanDeps {
  return {
    readDir: (dir) => {
      try {
        return readdirSync(dir, { withFileTypes: true }).map((e) => ({
          name: e.name,
          isDir: e.isDirectory(),
        }));
      } catch {
        return [];
      }
    },
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    exists: existsSync,
    join,
    // process.arch reflects the Electron binary (x64); the host OS is
    // 64-bit Windows in every supported case. Gate on the OS bitness the
    // installscript cares about, not the app arch.
    is64BitWindows: process.platform === 'win32' && process.arch !== 'ia32',
  };
}

/**
 * Run the installers elevated via a single throwaway batch file. One UAC
 * prompt covers the whole set — the batch inherits the elevation, so the
 * individual requireAdministrator installers don't each re-prompt.
 *
 * `--%` is not needed here since we control the paths/args; each line is
 * quoted. Runs hidden and waits so the caller can flip the install to
 * `installed` only after every runtime is in place.
 */
async function runElevatedBatch(
  items: RedistItem[],
  onProgress?: RedistProgress
): Promise<void> {
  const stamp = `${process.pid}-${Date.now()}`;
  const batPath = join(tmpdir(), `steam-client-redist-${stamp}.bat`);
  // The batch writes the 1-based index of the package it's about to run to
  // this file; the (non-elevated) parent polls it to drive the UI step.
  const progressPath = join(tmpdir(), `steam-client-redist-${stamp}.progress`);
  const lines = [
    '@echo off',
    // `call` is required: some installscript processes are .cmd wrappers
    // (e.g. ".NET 4.7.2.cmd", "Visual C++ 2022 x64.cmd") — running a .cmd
    // WITHOUT `call` hands control away and never returns to this batch, so
    // later installers silently never run. `call` works for .exe too, so we
    // use it uniformly. Paths are quoted (installscript names contain
    // spaces). Non-zero exits (e.g. 1638 "newer version already installed")
    // are a success for our purposes, so we don't stop on them.
    ...items.flatMap((it, i) => [
      // `echo N > file` needs the space — `echo N>file` makes cmd read the
      // digit as a redirect stream id (stdout) and writes an empty line.
      // The trailing space is harmless: the poller parseInt-trims it.
      `echo ${i + 1} > "${progressPath}"`,
      `call "${it.path}"${it.args.length ? ' ' + it.args.join(' ') : ''}`,
    ]),
    'exit /b 0',
  ];
  writeFileSync(batPath, lines.join('\r\n'), 'utf8');

  let lastIdx = 0;
  const poll = onProgress
    ? setInterval(() => {
        let raw: string;
        try {
          raw = readFileSync(progressPath, 'utf8');
        } catch {
          return; // not written yet
        }
        const idx = parseInt(raw.trim(), 10);
        if (Number.isInteger(idx) && idx > lastIdx && idx <= items.length) {
          lastIdx = idx;
          onProgress(idx, items.length, items[idx - 1]!.label);
        }
      }, 300)
    : null;

  try {
    // Emit the first step immediately so the UI shows the redist phase the
    // moment the (blocking) UAC prompt appears, before any poll tick.
    onProgress?.(1, items.length, items[0]!.label);
    await new Promise<void>((resolve, reject) => {
      // Start-Process -Verb RunAs triggers the single UAC prompt; -Wait
      // blocks until the elevated batch (and thus all installers) exits.
      // The .bat runs through its cmd.exe association, so we launch it
      // directly rather than shelling `cmd /c` ourselves.
      const psCmd =
        `$p = Start-Process -FilePath '${batPath}' ` +
        `-Verb RunAs -WindowStyle Hidden -Wait -PassThru; ` +
        `exit $p.ExitCode`;
      const ps = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCmd],
        { windowsHide: true }
      );
      let stderr = '';
      let settled = false;
      // Bail if the elevated batch never exits (a hung/interactive installer).
      // Killing our launcher process unblocks the pipeline; the redist marker
      // stays unwritten so the next launch retries.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ps.kill();
        } catch {
          /* best-effort */
        }
        reject(new Error('elevated redist batch timed out'));
      }, REDIST_BATCH_TIMEOUT_MS);
      ps.stderr?.on('data', (d) => {
        stderr += d.toString();
      });
      ps.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      ps.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Non-zero here usually means the user declined the UAC prompt
        // (PowerShell surfaces that as a terminating error). Treat as a
        // soft failure so installRedists doesn't write the done-marker.
        if (code === 0) resolve();
        else reject(new Error(`elevated batch exit ${code}${stderr ? `: ${stderr.trim().slice(0, 200)}` : ''}`));
      });
    });
  } finally {
    if (poll) clearInterval(poll);
    for (const p of [batPath, progressPath]) {
      try {
        unlinkSync(p);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

/**
 * Convenience entry point used by the download pipeline: install every
 * bundled runtime for a freshly-downloaded game, once, best-effort.
 * `onProgress` reports package N-of-M so the caller can show an
 * "Installing package N" step.
 */
export function defaultInstallRedists(
  installDir: string,
  onProgress?: RedistProgress
): Promise<RedistResult> {
  const scanDeps = realScanDeps();
  return installRedists(
    installDir,
    {
      scan: (dir) => scanRedists(dir, scanDeps),
      pathExists: existsSync,
      writeMarker: (p) => {
        try {
          writeFileSync(p, new Date().toISOString(), 'utf8');
        } catch {
          /* marker is an optimisation; ignore write failures */
        }
      },
      markerPath: (dir) => join(dir, MARKER_NAME),
      runElevated: runElevatedBatch,
      platform: process.platform,
    },
    onProgress
  );
}
