/**
 * Post-install DRM-removal pipeline.
 *
 * After DepotDownloader writes a depot to disk, the resulting install is a
 * vanilla Steam-encumbered build: every .exe carrying SteamStub re-verifies
 * ownership against the running Steam process before it will boot, and
 * `steam_api*.dll` is the official Valve shim that calls into steamclient
 * for the same check. Without a real Steam process (or with one signed in
 * as the wrong user) the game refuses to start.
 *
 * `applyDrmPatches` rewrites the install tree so the game boots standalone:
 *
 *   1. Walk `installDir` for .exe files and feed each to Steamless.CLI.exe.
 *      Steamless strips the SteamStub wrapper and writes an `<exe>.unpacked`
 *      sibling — we then move the original to `.bak` and slot the unpacked
 *      copy in. Exes without SteamStub produce no output and we skip them.
 *   2. For every `steam_api.dll` / `steam_api64.dll` in the tree:
 *      a. Run gbe_fork's `generate_interfaces_<arch>.exe` against the
 *         ORIGINAL Valve DLL — gbe_fork refuses to load on modern Steam
 *         SDKs (>1.51) without a per-game `steam_interfaces.txt` listing
 *         the C++ interface versions the DLL exports. This was the silent
 *         "RestartAppIfNecessary returns true, Steam launches" failure mode
 *         on the previous Goldberg v0.2.5 setup.
 *      b. Copy the original to `<dll>.bak`.
 *      c. Replace the DLL with the bundled gbe_fork build (regular flavour,
 *         single-DLL, no steamclient dependency).
 *      d. Drop `steam_settings/` next to the DLL containing the generated
 *         `steam_interfaces.txt` plus the bundled `configs.{user,main}.ini`.
 *   3. Write `steam_appid.txt` BOTH next to the main exe AND next to every
 *      replaced DLL. The DLL resolves the file relative to its own path,
 *      not the launching process — UE games with the DLL six levels deep
 *      would never find a single copy at the install root.
 *
 * Idempotency: each step is safe to re-run. gbe_fork DLLs are identified by
 * a `.gbe_fork` marker file written alongside the replaced DLL; if present
 * we skip re-replacement on subsequent runs (so update flows that re-fetch
 * official DLLs trigger a re-patch, but a no-op update pass doesn't churn).
 * The marker name intentionally differs from the legacy `.goldberg` marker
 * so installs patched with the broken v0.2.5 setup are detected as needing
 * a re-patch.
 *
 * Platform: Steamless and `generate_interfaces_*.exe` are Windows PE
 * binaries. Native execution only works on Windows; on Linux dev / a host
 * without Wine we skip both subprocess steps (logging a warning) and still
 * proceed with the DLL swap, the configs.ini copy, and the appid files,
 * which is enough for most non-stubbed pre-SDK-1.51 titles. The gbe_fork
 * DLLs themselves are Windows PE — copying them on a Linux host is still
 * correct because the game is run under Wine/Proton.
 */
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { app } from 'electron';
import log from 'electron-log/main.js';

/**
 * True when `dllPath` is the gbe_fork build (not Valve's original). The
 * emulator embeds the literal `gbe_fork` identity string, which Valve's
 * steam_api.dll never contains — a far more reliable "is it patched?"
 * signal than the `.gbe_fork` marker file, since a DD -validate restores
 * the stock DLL over our swap but leaves the marker behind. Reads the
 * whole file (a few MB) — only called on the launch/patch path.
 */
export function isGbeForkDll(dllPath: string): boolean {
  try {
    return readFileSync(dllPath).includes('gbe_fork');
  } catch {
    return false;
  }
}

/** How deep we recurse looking for .exe / steam_api*.dll files. */
const MAX_WALK_DEPTH = 6;

/** Per-exe Steamless timeout. Most stubs unpack in <2s; budget generously. */
const STEAMLESS_TIMEOUT_MS = 60_000;

/** Per-DLL interface generator timeout. Tool finishes in <1s in practice. */
const INTERFACES_TIMEOUT_MS = 30_000;

/** Subdirectories that never contain shipping binaries — skip recursion. */
const SKIP_RECURSE = new Set([
  'node_modules',
  '.git',
  'engine',
  'content',
  'saved',
  'plugins',
  '_commonredist',
  'commonredist',
  'redist',
]);

export interface DrmPatchReport {
  /** Original exe paths whose Steamless run produced an unpacked sibling. */
  steamlessUnpacked: string[];
  /** Exes Steamless rejected / errored on (logged, not fatal). */
  steamlessFailed: Array<{ exe: string; reason: string }>;
  /** Steam API DLL paths replaced with gbe_fork builds this run. */
  dllsReplaced: string[];
  /** Steam API DLLs already swapped on a previous run (skipped). */
  dllsSkipped: string[];
  /** steamclient(64).dll paths written next to a steam_api*.dll this run. */
  steamclientDllsCopied: string[];
  /** Per-DLL steam_interfaces.txt files written this run. */
  interfacesGenerated: string[];
  /** DLLs whose interface generation failed (logged, not fatal). */
  interfacesFailed: Array<{ dll: string; reason: string }>;
  /** Absolute paths of steam_appid.txt files written this run. */
  steamAppidTxt: string[];
  /** Set when Steamless was skipped entirely (non-Windows, no CLI found). */
  steamlessSkippedReason: string | null;
  /** Set when the interfaces generator was skipped entirely. */
  interfacesSkippedReason: string | null;
  /** ColdClientLoader exes copied next to a game exe this run. */
  coldClientLoadersCopied: string[];
  /** Per-install ColdClientLoader.ini files written this run. */
  coldClientIniWritten: string[];
}

/**
 * Resolve the Steamless CLI binary. Same resolution order as DD:
 *   1. STEAMLESS_CLI_PATH env override.
 *   2. Packaged extraResources: <resources>/vendor/win-x64/steamless/.
 *   3. Dev repo: <cwd>/vendor/win-x64/steamless/.
 *
 * Returns null when not present — caller logs and skips Steamless.
 */
export function resolveSteamlessCliPath(): string | null {
  const fromEnv = process.env.STEAMLESS_CLI_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const exeName = 'Steamless.CLI.exe';
  const subdir = 'win-x64';

  const bundled =
    app.isPackaged
      ? join(process.resourcesPath, 'vendor', subdir, 'steamless', exeName)
      : null;
  if (bundled && existsSync(bundled)) return bundled;

  for (const cand of [
    resolve(process.cwd(), 'vendor', subdir, 'steamless', exeName),
    resolve(process.cwd(), '..', '..', 'vendor', subdir, 'steamless', exeName),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * Resolve a gbe_fork vendor DLL by basename. Both x86 (steam_api.dll) and
 * x64 (steam_api64.dll) live in the same vendor/win-x64/gbe_fork/ folder.
 */
export function resolveGbeForkDllPath(name: string): string | null {
  const subdir = 'win-x64';
  const bundled =
    app.isPackaged
      ? join(process.resourcesPath, 'vendor', subdir, 'gbe_fork', name)
      : null;
  if (bundled && existsSync(bundled)) return bundled;
  for (const cand of [
    resolve(process.cwd(), 'vendor', subdir, 'gbe_fork', name),
    resolve(process.cwd(), '..', '..', 'vendor', subdir, 'gbe_fork', name),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * Resolve the bundled steam_settings/ directory we copy alongside each
 * gbe_fork DLL. Contains the curated configs.user.ini / configs.main.ini —
 * steam_interfaces.txt is computed per-DLL at patch time, not bundled.
 */
export function resolveGbeForkSettingsDir(): string | null {
  const subdir = 'win-x64';
  const bundled =
    app.isPackaged
      ? join(process.resourcesPath, 'vendor', subdir, 'gbe_fork', 'steam_settings')
      : null;
  if (bundled && existsSync(bundled)) return bundled;
  for (const cand of [
    resolve(process.cwd(), 'vendor', subdir, 'gbe_fork', 'steam_settings'),
    resolve(process.cwd(), '..', '..', 'vendor', subdir, 'gbe_fork', 'steam_settings'),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * Resolve the bundled gbe_fork `steamclient(64).dll` (experimental build).
 *
 * The regular single-DLL gbe_fork flavour we ship as `steam_api*.dll` does
 * not itself import `steamclient(64).dll`, but many shipping titles call
 * `LoadLibrary("steamclient64.dll")` directly from their main exe (or from
 * a SteamStub stub we couldn't strip). Without a real Steam install the
 * lookup fails and the game errors out with "Unable to load
 * steamclient64.dll". Dropping the gbe_fork experimental steamclient build
 * next to the game's binaries satisfies that LoadLibrary call — Windows'
 * default DLL search order resolves it from the loading process's exe
 * directory, and the gbe_fork dll responds with the steamclient interface
 * surface the game expects.
 *
 * Both x86 and x64 builds ship in vendor (`experimental/steamclient.dll`
 * and `experimental/steamclient64.dll`). The x86 build is a hard
 * requirement of ColdClientLoader (see resolveColdClientLoaderExePath
 * docstring) — even the x64 loader still file_exist()s the 32-bit dll
 * and bails with "Couldn't find the requested SteamClientDll" if it's
 * missing. We drop it next to the loader so that probe passes.
 */
export function resolveGbeForkSteamclientDllPath(
  arch: 'x86' | 'x64'
): string | null {
  const name = arch === 'x64' ? 'steamclient64.dll' : 'steamclient.dll';
  const subdir = 'win-x64';
  const bundled =
    app.isPackaged
      ? join(
          process.resourcesPath,
          'vendor',
          subdir,
          'gbe_fork',
          'experimental',
          name
        )
      : null;
  if (bundled && existsSync(bundled)) return bundled;
  for (const cand of [
    resolve(
      process.cwd(),
      'vendor',
      subdir,
      'gbe_fork',
      'experimental',
      name
    ),
    resolve(
      process.cwd(),
      '..',
      '..',
      'vendor',
      subdir,
      'gbe_fork',
      'experimental',
      name
    ),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * Resolve the bundled gbe_fork ColdClientLoader exe (x64). The experimental
 * `steamclient64.dll` we drop into the install bails out of `SteamAPI_Init`
 * unless its host process was started by ColdClientLoader — the loader
 * sets up the IPC pipes / environment the dll expects (this used to be
 * the job of `steam.exe`, which we don't have on the user's box). Without
 * it the game pops the "Unable to initialize SteamAPI — please make sure
 * Steam is running" dialog and quits.
 *
 * Loader contract (tools/steamclient_loader/win/ColdClientLoader.cpp on
 * the dev branch of Detanup01/gbe_fork): the loader unconditionally
 * file_exist()s BOTH `SteamClientDll` (32-bit) AND `SteamClient64Dll`
 * (64-bit) keys from ColdClientLoader.ini before doing anything else.
 * It exits with "Couldn't find the requested SteamClientDll" if either
 * is missing, regardless of the target game's bitness. We therefore
 * drop both `steamclient.dll` and `steamclient64.dll` next to the loader
 * — the 32-bit one is a pure existence probe for the x64 loader (only
 * LoadLibrary'd if a 32-bit game were being launched, which we never
 * do), but it still has to physically exist on disk.
 *
 * Only the x64 build ships in our vendor tree; x86 main exes fall back to
 * a direct spawn (covered by the `steam_api.dll` regular flavour which
 * doesn't depend on steamclient).
 */
export function resolveColdClientLoaderExePath(): string | null {
  const subdir = 'win-x64';
  const exeName = 'steamclient_loader_x64.exe';
  const bundled =
    app.isPackaged
      ? join(process.resourcesPath, 'vendor', subdir, 'gbe_fork', exeName)
      : null;
  if (bundled && existsSync(bundled)) return bundled;
  for (const cand of [
    resolve(process.cwd(), 'vendor', subdir, 'gbe_fork', exeName),
    resolve(process.cwd(), '..', '..', 'vendor', subdir, 'gbe_fork', exeName),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * Same shape as {@link resolveColdClientLoaderExePath}, but resolves the
 * 32-bit build of the loader. The two loaders carry different file
 * names (x86 vs x64 suffix) and the matching one MUST be spawned for
 * the main exe or the loader bails with "Arch of loader and requested
 * exe are different" before SteamAPI even starts.
 */
export function resolveColdClientLoaderX86ExePath(): string | null {
  const subdir = 'win-x64';
  const exeName = 'steamclient_loader_x86.exe';
  const bundled =
    app.isPackaged
      ? join(process.resourcesPath, 'vendor', subdir, 'gbe_fork', exeName)
      : null;
  if (bundled && existsSync(bundled)) return bundled;
  for (const cand of [
    resolve(process.cwd(), 'vendor', subdir, 'gbe_fork', exeName),
    resolve(process.cwd(), '..', '..', 'vendor', subdir, 'gbe_fork', exeName),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * Resolve the ColdClientLoader.ini template the patcher renders next to
 * the main exe. Contains `{{EXE_NAME}}` / `{{APPID}}` placeholders.
 */
export function resolveColdClientLoaderTemplatePath(): string | null {
  const subdir = 'win-x64';
  const iniName = 'ColdClientLoader.template.ini';
  const bundled =
    app.isPackaged
      ? join(process.resourcesPath, 'vendor', subdir, 'gbe_fork', iniName)
      : null;
  if (bundled && existsSync(bundled)) return bundled;
  for (const cand of [
    resolve(process.cwd(), 'vendor', subdir, 'gbe_fork', iniName),
    resolve(process.cwd(), '..', '..', 'vendor', subdir, 'gbe_fork', iniName),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * Resolve the generate_interfaces tool for the requested arch. gbe_fork
 * ships separate x86 / x64 builds — we have to match the bitness of the
 * DLL being scanned because the tool loads the DLL into its own process
 * before walking its exports.
 */
export function resolveGenerateInterfacesExe(
  arch: 'x86' | 'x64'
): string | null {
  const exeName = arch === 'x64'
    ? 'generate_interfaces_x64.exe'
    : 'generate_interfaces_x86.exe';
  const subdir = 'win-x64';
  const bundled =
    app.isPackaged
      ? join(process.resourcesPath, 'vendor', subdir, 'gbe_fork', 'tools', exeName)
      : null;
  if (bundled && existsSync(bundled)) return bundled;
  for (const cand of [
    resolve(process.cwd(), 'vendor', subdir, 'gbe_fork', 'tools', exeName),
    resolve(process.cwd(), '..', '..', 'vendor', subdir, 'gbe_fork', 'tools', exeName),
  ]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/** Injectable Steamless runner so tests can stub the subprocess. */
export type SteamlessRunner = (
  cliPath: string,
  exePath: string
) => Promise<SteamlessResult>;

export interface SteamlessResult {
  /** Path of the unpacked sibling file, if Steamless produced one. */
  unpackedPath: string | null;
  /** Non-fatal error if Steamless ran but errored (parsed from stderr). */
  error: string | null;
  /** Raw subprocess stdout, captured for diagnostics. */
  stdout?: string;
  /** Raw subprocess stderr, captured for diagnostics. */
  stderr?: string;
}

/**
 * Injectable interfaces-generator runner. The tool's contract:
 *   - input: path to an ORIGINAL Valve steam_api*.dll
 *   - output: writes `steam_interfaces.txt` into its CWD (the directory of
 *     the DLL, since we always set cwd to dirname(dllPath))
 *   - return: the path of the written file, or an error string
 */
export type InterfacesRunner = (
  exePath: string,
  dllPath: string
) => Promise<InterfacesResult>;

export interface InterfacesResult {
  /** Path of the written steam_interfaces.txt, or null on failure. */
  outputPath: string | null;
  /** Non-fatal error if the tool ran but errored. */
  error: string | null;
}

const defaultSteamlessRunner: SteamlessRunner = (cliPath, exePath) =>
  new Promise<SteamlessResult>((resolveP) => {
    // Steamless.CLI options:
    //   --keepbind  preserve bind-data sections (needed by some games)
    //   --keepstub  retain the SteamStub header (some titles re-check it)
    // Both are recommended-defaults from the project README.
    const args = ['--keepbind', '--keepstub', exePath];
    let stdout = '';
    let stderr = '';
    let settled = false;
    let proc: ReturnType<typeof spawn> | null = null;
    try {
      proc = spawn(cliPath, args, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolveP({ unpackedPath: null, error: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        proc?.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }, STEAMLESS_TIMEOUT_MS);

    proc.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ unpackedPath: null, error: err.message });
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Steamless writes the unpacked file next to the original as
      // `<input>.unpacked.exe` (or `<input>.unpacked` when the input
      // has no .exe extension). The previous code stripped the .exe
      // before appending `.unpacked.exe`, which produced
      // `arma3_x64.unpacked.exe` for an `arma3_x64.exe` input — a
      // path Steamless never creates. Real Steamless output is
      // `arma3_x64.exe.unpacked.exe`; an install with the correct
      // Steamless output therefore looked "no unpacked file" to the
      // patcher, the self-heal was never triggered, and the launcher
      // kept picking the SteamStub-wrapped original (Arma III loop).
      // Try the real Steamless naming first, then the legacy
      // `<basename>.unpacked.exe` shape as a fallback so any older
      // installs aren't broken by the rename.
      const exeLower = exePath.toLowerCase();
      const candidates = exeLower.endsWith('.exe')
        ? [exePath + '.unpacked.exe', exePath.slice(0, -4) + '.unpacked.exe']
        : [exePath + '.unpacked.exe'];
      const altCandidate = exePath + '.unpacked';
      const unpacked =
        candidates.find((p) => existsSync(p)) ??
        (existsSync(altCandidate) ? altCandidate : null);
      if (code !== 0 && !unpacked) {
        resolveP({
          unpackedPath: null,
          error: (stderr || stdout || `exit_${code ?? 'null'}`)
            .trim()
            .slice(0, 200),
          stdout,
          stderr,
        });
        return;
      }
      resolveP({ unpackedPath: unpacked, error: null, stdout, stderr });
    });
  });

const defaultInterfacesRunner: InterfacesRunner = (exePath, dllPath) =>
  new Promise<InterfacesResult>((resolveP) => {
    let stderr = '';
    let stdout = '';
    let settled = false;
    let proc: ReturnType<typeof spawn> | null = null;
    const cwd = dirname(dllPath);
    const output = join(cwd, 'steam_interfaces.txt');
    try {
      // The tool writes steam_interfaces.txt into its CWD; setting cwd to
      // dirname(dll) keeps everything scoped to that DLL's folder so two
      // concurrent runs on different DLLs don't collide on the output.
      proc = spawn(exePath, [basename(dllPath)], {
        shell: false,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolveP({ outputPath: null, error: (err as Error).message });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        proc?.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }, INTERFACES_TIMEOUT_MS);
    proc.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    proc.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ outputPath: null, error: err.message });
    });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (existsSync(output)) {
        resolveP({ outputPath: output, error: null });
        return;
      }
      resolveP({
        outputPath: null,
        error: (stderr || stdout || `exit_${code ?? 'null'}`)
          .trim()
          .slice(0, 200),
      });
    });
  });

export interface ApplyDrmPatchesOptions {
  /** Test seam: override the Steamless subprocess. */
  steamlessRunner?: SteamlessRunner;
  /** Test seam: override Steamless CLI path resolution. */
  steamlessCliPath?: string | null;
  /** Test seam: override the interfaces-generator subprocess. */
  interfacesRunner?: InterfacesRunner;
  /** Test seam: override the x86 / x64 interfaces-generator paths. */
  interfacesExeX86?: string | null;
  interfacesExeX64?: string | null;
  /** Test seam: override gbe_fork vendor DLL paths. */
  gbeForkX86Path?: string | null;
  gbeForkX64Path?: string | null;
  /** Test seam: override gbe_fork experimental steamclient(64).dll paths. */
  gbeForkSteamclientX86Path?: string | null;
  gbeForkSteamclientX64Path?: string | null;
  /** Test seam: override the bundled steam_settings directory. */
  gbeForkSettingsDir?: string | null;
  /** Test seam: override the ColdClientLoader exe path. */
  coldClientLoaderExePath?: string | null;
  /**
   * Test seam: override the x86 ColdClientLoader exe path. Used only in
   * the arch-known x86 flow (ColdClientLoader is a 64-bit-only build by
   * default and bails with "Arch of loader and requested exe are
   * different" when handed a 32-bit main exe). The arch-aware spawn path
   * in index.ts picks the matching-arch loader from the install dir, so
   * this override mirrors the x64 one for tests.
   */
  coldClientLoaderX86ExePath?: string | null;
  /** Test seam: override the ColdClientLoader.ini template path. */
  coldClientLoaderTemplatePath?: string | null;
  /** Test seam: pretend we're on Windows (bypass platform gate). */
  forceSteamless?: boolean;
  /** Test seam: pretend we're on Windows for interfaces generation. */
  forceInterfaces?: boolean;
  /**
   * When set, restrict the patcher to a single architecture:
   *   - Only the matching gbe_fork `steam_api*.dll` (regular flavour) is
   *     dropped. The other arch's Valve DLL is left intact, even if it
   *     exists in the same install tree (rare — only dual-arch shipping
   *     layouts like Arma III, where the x86 launch helper should NOT
   *     be touched because we're not launching it).
   *   - The matching experimental `steamclient(64).dll` is still dropped
   *     (modern titles call `LoadLibrary("steamclient64.dll")` directly
   *     from the main exe). The other arch's experimental DLL is
   *     skipped to keep the install clean.
   *   - ColdClientLoader pieces (exe, ini) are skipped. With the
   *     architecture known in advance, we drop only the matching DLL
   *     and the game exe loads it via the standard Windows DLL search
   *     order — no host process needed. The new flow also lets us
   *     avoid compiling the x86 ColdClientLoader, which was previously
   *     a hard requirement of the dual-arch setup.
   *
   * When unset, behaviour matches the original dual-arch pipeline:
   * both gbe_fork DLLs are dropped, ColdClientLoader pieces are
   * rendered (used by all existing tests).
   *
   * Production callers should always pass this — the only legitimate
   * "unset" path is the legacy dual-arch fallback during the drm-patcher
   * migration.
   */
  arch?: 'x86' | 'x64';
}

/**
 * Run the full Steam-DRM-removal pipeline against `installDir`.
 *
 * - `appid` populates the per-install steam_appid.txt so gbe_fork knows
 *   which title to impersonate.
 * - `mainExePath` is where steam_appid.txt is dropped FIRST (next to the
 *   main game binary). A second copy is then dropped next to every
 *   replaced DLL because gbe_fork resolves the file relative to the DLL.
 *
 * Returns a report describing what happened. The function never throws on
 * a per-file failure — DRM patching is best-effort, and partial coverage
 * is preferable to refusing to mark a multi-GB download as installed.
 */
export async function applyDrmPatches(
  installDir: string,
  appid: number,
  mainExePath: string,
  opts: ApplyDrmPatchesOptions = {}
): Promise<DrmPatchReport> {
  const report: DrmPatchReport = {
    steamlessUnpacked: [],
    steamlessFailed: [],
    dllsReplaced: [],
    dllsSkipped: [],
    steamclientDllsCopied: [],
    interfacesGenerated: [],
    interfacesFailed: [],
    steamAppidTxt: [],
    steamlessSkippedReason: null,
    interfacesSkippedReason: null,
    coldClientLoadersCopied: [],
    coldClientIniWritten: [],
  };

  if (!existsSync(installDir)) {
    log.warn('[drm-patcher] install dir missing, skipping', installDir);
    report.steamlessSkippedReason = 'install_dir_missing';
    report.interfacesSkippedReason = 'install_dir_missing';
    return report;
  }

  log.info('[drm-patcher] start', { installDir, appid, mainExePath });

  // ── 1. Steamless ────────────────────────────────────────────────────
  const cliPath =
    opts.steamlessCliPath !== undefined
      ? opts.steamlessCliPath
      : resolveSteamlessCliPath();
  const canRunSteamless =
    !!cliPath && (opts.forceSteamless || process.platform === 'win32');
  if (!cliPath) {
    log.warn('[drm-patcher] Steamless CLI not found — skipping SteamStub step');
    report.steamlessSkippedReason = 'cli_not_found';
  } else if (!canRunSteamless) {
    log.warn(
      '[drm-patcher] Steamless cannot run on this platform — skipping SteamStub step',
      process.platform
    );
    report.steamlessSkippedReason = `platform_${process.platform}`;
  } else {
    const runner = opts.steamlessRunner ?? defaultSteamlessRunner;
    const exes = walkFiles(installDir, isCandidateExe);
    log.info('[drm-patcher] scanning exes for SteamStub', {
      count: exes.length,
    });
    for (const exe of exes) {
      // Interrupted-swap self-heal: a previous Steamless run produced
      // `<exe>.unpacked.exe` but the swap to `<exe>` never finished (the
      // launcher crashed, the user killed it, antivirus quarantined the
      // rename, whatever). SteamStub is still on the original, and the
      // bare exe will dial `steam://run/<appid>` and trigger a Steam
      // re-launch loop. Complete the swap WITHOUT re-running Steamless
      // (the unpacked output is already on disk and valid) before paying
      // for another Steamless pass that would just rewrite the same
      // bytes.
      const bakPath = exe + '.bak';
      // Steamless writes the unpacked sibling as `<input>.unpacked.exe`
      // for .exe inputs. Keep the legacy `<basename>.unpacked.exe`
      // shape as a fallback so an older Steamless build or a hand-rolled
      // unpacked file still triggers the self-heal.
      const candidates = exe.toLowerCase().endsWith('.exe')
        ? [exe + '.unpacked.exe', exe.slice(0, -4) + '.unpacked.exe']
        : [exe + '.unpacked.exe'];
      const unpackedPre =
        candidates.find((p) => existsSync(p)) ??
        (existsSync(exe + '.unpacked') ? exe + '.unpacked' : null);
      if (unpackedPre && !existsSync(bakPath)) {
        log.info(
          '[drm-patcher] completing interrupted Steamless swap',
          { exe, unpacked: unpackedPre }
        );
        try {
          renameSync(exe, bakPath);
          renameSync(unpackedPre, exe);
          report.steamlessUnpacked.push(exe);
          log.info('[drm-patcher] unpacked SteamStub (resumed)', exe);
          continue;
        } catch (err) {
          log.warn(
            '[drm-patcher] interrupted-swap recovery failed for',
            exe,
            (err as Error).message
          );
          // Fall through to the normal Steamless pass — it'll regenerate
          // the unpacked output and try the swap again.
        }
      }
      try {
        const result = await runner(cliPath, exe);
        if (result.unpackedPath) {
          // Atomic-ish swap: original → .bak, unpacked → original. If the
          // .bak already exists (re-run), overwrite it.
          const bak = exe + '.bak';
          try {
            if (existsSync(bak)) {
              // Best-effort: drop the stale backup so renameSync can land.
              // We do this rather than skipping because the up-to-date
              // backup of "original original" was made on the first run;
              // the current `exe` is already the unpacked version and
              // we're just re-stamping it from a no-op Steamless pass.
              try {
                renameSync(bak, bak + '.prev');
              } catch {
                /* ignore */
              }
            }
            renameSync(exe, bak);
            renameSync(result.unpackedPath, exe);
            report.steamlessUnpacked.push(exe);
            log.info('[drm-patcher] unpacked SteamStub', exe);
          } catch (err) {
            log.warn(
              '[drm-patcher] swap failed for',
              exe,
              (err as Error).message
            );
            report.steamlessFailed.push({
              exe,
              reason: `swap_failed: ${(err as Error).message}`,
            });
          }
        } else if (result.error) {
          report.steamlessFailed.push({ exe, reason: result.error });
          log.info('[drm-patcher] Steamless declined', {
            exe,
            reason: result.error,
            stdout: result.stdout?.trim().slice(0, 500),
            stderr: result.stderr?.trim().slice(0, 500),
          });
        } else {
          // "Not a SteamStub binary" is a normal, expected outcome but used
          // to be swallowed — surface the CLI output so we don't lose the
          // explanation when investigating later.
          log.info('[drm-patcher] Steamless: no SteamStub', {
            exe,
            stdout: result.stdout?.trim().slice(0, 500),
            stderr: result.stderr?.trim().slice(0, 500),
          });
        }
      } catch (err) {
        report.steamlessFailed.push({
          exe,
          reason: (err as Error).message,
        });
        log.warn(
          '[drm-patcher] Steamless threw on',
          exe,
          (err as Error).message
        );
      }
    }
  }

  // ── 2. gbe_fork DLL swap (+ interfaces gen + steam_settings) ───────
  const gbeX86 =
    opts.gbeForkX86Path !== undefined
      ? opts.gbeForkX86Path
      : resolveGbeForkDllPath('steam_api.dll');
  const gbeX64 =
    opts.gbeForkX64Path !== undefined
      ? opts.gbeForkX64Path
      : resolveGbeForkDllPath('steam_api64.dll');
  const steamclientX86 =
    opts.gbeForkSteamclientX86Path !== undefined
      ? opts.gbeForkSteamclientX86Path
      : resolveGbeForkSteamclientDllPath('x86');
  const steamclientX64 =
    opts.gbeForkSteamclientX64Path !== undefined
      ? opts.gbeForkSteamclientX64Path
      : resolveGbeForkSteamclientDllPath('x64');
  const interfacesX86 =
    opts.interfacesExeX86 !== undefined
      ? opts.interfacesExeX86
      : resolveGenerateInterfacesExe('x86');
  const interfacesX64 =
    opts.interfacesExeX64 !== undefined
      ? opts.interfacesExeX64
      : resolveGenerateInterfacesExe('x64');
  const settingsSrc =
    opts.gbeForkSettingsDir !== undefined
      ? opts.gbeForkSettingsDir
      : resolveGbeForkSettingsDir();
  const interfacesRunner = opts.interfacesRunner ?? defaultInterfacesRunner;
  const canRunInterfaces =
    opts.forceInterfaces || process.platform === 'win32';
  if (!interfacesX86 && !interfacesX64) {
    log.warn(
      '[drm-patcher] generate_interfaces tool not found in vendor — interfaces.txt step disabled'
    );
    report.interfacesSkippedReason = 'tool_not_found';
  } else if (!canRunInterfaces) {
    log.warn(
      '[drm-patcher] generate_interfaces cannot run on this platform — DLL will load without interfaces.txt',
      process.platform
    );
    report.interfacesSkippedReason = `platform_${process.platform}`;
  }

  if (!gbeX86 && !gbeX64) {
    log.warn(
      '[drm-patcher] no gbe_fork DLLs found in vendor — skipping DLL swap'
    );
  } else {
    const allDlls = scanForSteamApiDlls(installDir);
    // When the caller passes `opts.arch`, narrow the DLL list to ONLY
    // the matching architecture. Dual-arch shipping layouts (Arma III:
    // `arma3.exe` 32-bit + `arma3_x64.exe` 64-bit in the same directory)
    // legitimately ship BOTH Valve DLLs and we only want to swap the
    // one we'll actually launch — leaving the unused arch's Valve DLL
    // intact avoids breaking the other launch helper if the user
    // double-clicks it via explorer.
    const dlls = opts.arch
      ? allDlls.filter((d) => {
          const lower = basename(d).toLowerCase();
          const isX64 = lower === 'steam_api64.dll';
          return opts.arch === 'x64' ? isX64 : !isX64;
        })
      : allDlls;
    log.info('[drm-patcher] scanning for steam_api*.dll', {
      count: dlls.length,
      ...(opts.arch ? { arch: opts.arch, scannedAll: allDlls.length } : {}),
    });
    // Defensive warning when arch-known mode finds no matching DLL —
    // could mean the resolveMainExe appinfo path gave us a Windows
    // launch exe, but the matching Valve steam_api*.dll isn't on disk
    // yet (DD still extracting), or the arch passed by the caller
    // disagrees with what was actually downloaded. Either way, the
    // launch will fail at runtime with a missing-DLL error if we
    // silently move on — surface the mismatch so logs have a clue.
    if (opts.arch && allDlls.length > 0 && dlls.length === 0) {
      const otherArch = opts.arch === 'x64' ? 'steam_api64.dll' : 'steam_api.dll';
      log.warn(
        '[drm-patcher] arch-known mode requested but only the wrong-arch Valve DLL is present',
        { requested: opts.arch, presentArch: otherArch === 'steam_api64.dll' ? 'x86' : 'x64' }
      );
    }
    for (const dll of dlls) {
      const lower = basename(dll).toLowerCase();
      const isX64 = lower === 'steam_api64.dll';
      const src = isX64 ? gbeX64 : gbeX86;
      if (!src) {
        log.warn('[drm-patcher] no gbe_fork replacement for', dll);
        continue;
      }
      const marker = dll + '.gbe_fork';
      // Skip only when the marker is present AND the DLL is actually the
      // gbe_fork build. A DD -validate run (the on-launch update check)
      // restores Valve's original steam_api.dll over our swap because the
      // gbe_fork DLL doesn't match the depot manifest — but it leaves the
      // `.gbe_fork` marker (not in the manifest) behind. A marker-only
      // check then wrongly treats the restored stock DLL as patched, so the
      // game loads Valve's steam_api and fails SteamAPI_Init (e.g. Coffee
      // Talk crashing right after the Unity splash). Re-swap in that case.
      if (existsSync(marker) && isGbeForkDll(dll)) {
        report.dllsSkipped.push(dll);
        log.debug('[drm-patcher] gbe_fork already applied to', dll);
        continue;
      }
      if (existsSync(marker)) {
        log.info(
          '[drm-patcher] marker present but DLL is stock (DD -validate restored it) — re-applying',
          dll
        );
        try {
          unlinkSync(marker);
        } catch {
          /* best-effort — the swap below overwrites regardless */
        }
      }

      const dllDir = dirname(dll);
      const settingsDest = join(dllDir, 'steam_settings');

      // 2a. Generate steam_interfaces.txt from the ORIGINAL Valve DLL,
      //     BEFORE we overwrite it. The tool walks the DLL's exports to
      //     emit the interface-version strings gbe_fork needs at load.
      const ifaceExe = isX64 ? interfacesX64 : interfacesX86;
      if (ifaceExe && canRunInterfaces) {
        try {
          const r = await interfacesRunner(ifaceExe, dll);
          if (r.outputPath && existsSync(r.outputPath)) {
            // Move the generated file into steam_settings/ — the tool
            // drops it next to the DLL, but gbe_fork reads it from
            // steam_settings/ at load time.
            try {
              mkdirSync(settingsDest, { recursive: true });
              const finalPath = join(settingsDest, 'steam_interfaces.txt');
              try {
                renameSync(r.outputPath, finalPath);
              } catch {
                // cross-device or already-present: fall back to copy+unlink.
                copyFileSync(r.outputPath, finalPath);
              }
              report.interfacesGenerated.push(finalPath);
              log.info('[drm-patcher] wrote steam_interfaces.txt', finalPath);
            } catch (err) {
              report.interfacesFailed.push({
                dll,
                reason: `move_failed: ${(err as Error).message}`,
              });
              log.warn(
                '[drm-patcher] failed to place interfaces.txt for',
                dll,
                (err as Error).message
              );
            }
          } else if (r.error) {
            report.interfacesFailed.push({ dll, reason: r.error });
            log.warn(
              '[drm-patcher] generate_interfaces failed for',
              dll,
              r.error
            );
          }
        } catch (err) {
          report.interfacesFailed.push({
            dll,
            reason: (err as Error).message,
          });
          log.warn(
            '[drm-patcher] generate_interfaces threw on',
            dll,
            (err as Error).message
          );
        }
      }

      // 2b/c. Back up the original DLL and slot in the gbe_fork build.
      //
      // SKIPPED in arch-known mode. The arch-aware launch flow pairs the
      // matching-arch gbe_fork `steamclient*.dll` (experimental build)
      // with a ColdClientLoader that synthesises the Steam IPC pipes
      // Valve's original `steam_api.dll` expects. Replacing Valve's DLL
      // with gbe_fork's regular-flavour `steam_api*.dll` here breaks
      // that handshake: the experimental build's whole point is to
      // leave Valve's API surface intact and serve its interface
      // queries through the injected backend. Pure-x86 single-arch
      // titles like Conflict: Desert Storm and Postal Plus abort
      // with "Can't initialize Steamworks" when we do the swap (the
      // crash happens because the game's `SteamAPI_Init` call flows
      // through Valve's DLL into an `IPCClient_Connect` that finds
      // our injected steamclient but expects Valve's DLL to be on
      // the other end of those pipes — it isn't, gbe_fork regular is).
      // The dual-arch legacy flow (no `opts.arch`) keeps the swap
      // because gbe_fork regular is its entire backend — there is
      // no steamclient injection in that mode.
      if (opts.arch) {
        log.info(
          '[drm-patcher] arch-known mode — keeping Valve steam_api*.dll, using experimental steamclient backend',
          { dll, arch: opts.arch }
        );
      } else {
        try {
          const bak = dll + '.bak';
          if (!existsSync(bak)) {
            // Preserve the original Valve DLL on the first patch run only;
            // subsequent passes (after DD re-downloads it on update) get a
            // fresh .bak because we delete the marker below.
            copyFileSync(dll, bak);
          }
          copyFileSync(src, dll);
          writeFileSync(marker, new Date().toISOString());
          report.dllsReplaced.push(dll);
          log.info('[drm-patcher] replaced with gbe_fork', dll);
        } catch (err) {
          log.warn(
            '[drm-patcher] failed to swap DLL',
            dll,
            (err as Error).message
          );
          continue;
        }
      }

      // 2d-pre. Drop the gbe_fork experimental steamclient(64).dll next to
      //     the steam_api*.dll. Some games / un-stripped SteamStub blobs
      //     call LoadLibrary("steamclient64.dll") directly from the main
      //     exe; without a real Steam install that fails with the
      //     "Unable to load steamclient64.dll" error. The gbe_fork
      //     experimental build is a drop-in steamclient that responds to
      //     those interface calls, and Windows' default DLL search order
      //     resolves it from the exe's directory. We copy it next to the
      //     replaced API DLL because UE-style installs put the API DLL
      //     deep beside the exe that loads it.
      const steamclientSrc = isX64 ? steamclientX64 : steamclientX86;
      if (steamclientSrc && existsSync(steamclientSrc)) {
        const steamclientName = isX64
          ? 'steamclient64.dll'
          : 'steamclient.dll';
        const steamclientDest = join(dllDir, steamclientName);
        if (!existsSync(steamclientDest)) {
          try {
            copyFileSync(steamclientSrc, steamclientDest);
            report.steamclientDllsCopied.push(steamclientDest);
            log.info(
              '[drm-patcher] dropped gbe_fork steamclient',
              steamclientDest
            );
          } catch (err) {
            log.warn(
              '[drm-patcher] failed to copy steamclient to',
              steamclientDest,
              (err as Error).message
            );
          }
        } else {
          log.debug(
            '[drm-patcher] steamclient already present',
            steamclientDest
          );
        }
      } else if (isX64) {
        // x64 vendor DLL is mandatory in our ship — log if missing.
        log.warn(
          '[drm-patcher] no gbe_fork steamclient64.dll in vendor — skipping copy for',
          dll
        );
      }

      // 2d. Copy the bundled steam_settings configs next to the DLL.
      //     steam_interfaces.txt already lives in this directory if 2a
      //     succeeded; copyDirShallow won't overwrite it (it skips
      //     pre-existing targets).
      if (settingsSrc && existsSync(settingsSrc)) {
        try {
          copyDirShallow(settingsSrc, settingsDest);
        } catch (err) {
          log.warn(
            '[drm-patcher] failed to copy steam_settings to',
            settingsDest,
            (err as Error).message
          );
        }
      }

      // 2e. steam_appid.txt next to the DLL — gbe_fork reads it relative
      //     to the DLL's path, not the main exe. UE games bury the DLL
      //     many levels below the install root, so a single copy at the
      //     main exe isn't enough.
      try {
        const appidTxt = join(dllDir, 'steam_appid.txt');
        if (!existsSync(appidTxt)) {
          writeFileSync(appidTxt, String(appid));
          report.steamAppidTxt.push(appidTxt);
          log.info('[drm-patcher] wrote steam_appid.txt', appidTxt);
        }
      } catch (err) {
        log.warn(
          '[drm-patcher] failed to write per-DLL steam_appid.txt',
          (err as Error).message
        );
      }
    }
  }

  // ── 3. steam_appid.txt next to main exe ─────────────────────────────
  //   Belt-and-braces: the DLL-adjacent copies above cover gbe_fork's
  //   load-time read, but a few legacy code paths (and some games) probe
  //   the main exe's directory instead. Writing both keeps both happy.
  const mainExeDir = dirname(mainExePath);
  try {
    const target = join(mainExeDir, 'steam_appid.txt');
    if (!existsSync(target)) {
      writeFileSync(target, String(appid));
      report.steamAppidTxt.push(target);
      log.info('[drm-patcher] wrote steam_appid.txt', target);
    } else {
      log.debug('[drm-patcher] steam_appid.txt already present', target);
    }
  } catch (err) {
    log.warn('[drm-patcher] failed to write steam_appid.txt', (err as Error).message);
  }

  // SteamAPI_RestartAppIfNecessary reads steam_appid.txt from the process
   // CWD. We spawn with CWD = exe's dir, but drop a copy at the install
   // root too in case a future code path (or user double-click via
   // explorer) ends up launching with the root as CWD.
  if (mainExeDir !== installDir) {
    try {
      const rootTarget = join(installDir, 'steam_appid.txt');
      if (!existsSync(rootTarget)) {
        writeFileSync(rootTarget, String(appid));
        report.steamAppidTxt.push(rootTarget);
        log.info('[drm-patcher] wrote steam_appid.txt at install root', rootTarget);
      } else {
        log.debug('[drm-patcher] steam_appid.txt already present at install root', rootTarget);
      }
    } catch (err) {
      log.warn(
        '[drm-patcher] failed to write steam_appid.txt at install root',
        (err as Error).message
      );
    }
  }

  // ── 4. steamclient.dll + steamclient64.dll + steam_settings/ next ─
  //      to main exe.
  //   The experimental `steamclient*.dll` we drop here is a drop-in
  //   replacement that satisfies `LoadLibrary("steamclient64.dll")`
  //   calls coming directly from game code (regular gbe_fork doesn't
  //   import steamclient itself, but a few titles probe it explicitly).
  //   Windows' DLL search order resolves the load from the exe's own
  //   directory first — UE's shipping layout puts the Steamworks DLL
  //   six levels deep, but the main game exe resolves the load from
  //   `GameName/Binaries/Win64/`, so dropping the file there covers the
  //   common case.
  //   In legacy dual-arch mode we drop both 32-bit and 64-bit flavours
  //   (the 32-bit one was a probe artefact for ColdClientLoader — see
  //   section 5). With `opts.arch` set, we drop ONLY the matching arch:
  //   the unused arch's Valve-installed DLL is left untouched so a
  //   dual-arch shipping layout stays consistent with whichever launch
  //   helper the user might double-click from explorer.
  // gbe_fork's ColdClientLoader file_exist()s BOTH steamclient.dll AND
  // steamclient64.dll before it will launch — even the 32-bit loader checks
  // the 64-bit name (it's a hard-coded sanity probe upstream). So we drop
  // BOTH next to the exe regardless of the game's own arch. Narrowing to
  // the matching arch here (the old behaviour) left an x86 game with only
  // steamclient.dll, and the x86 loader then bailed with "Couldn't find the
  // requested SteamClient64Dll" — exactly the Republic Commando failure.
  const steamclientDrops: Array<{ src: string; name: string }> = [];
  if (steamclientX64 && existsSync(steamclientX64)) {
    steamclientDrops.push({ src: steamclientX64, name: 'steamclient64.dll' });
  } else {
    log.warn(
      '[drm-patcher] no gbe_fork steamclient64.dll in vendor — ColdClientLoader would bail "Couldn\'t find the requested SteamClient64Dll"',
      mainExePath
    );
  }
  if (steamclientX86 && existsSync(steamclientX86)) {
    steamclientDrops.push({ src: steamclientX86, name: 'steamclient.dll' });
  } else {
    log.warn(
      '[drm-patcher] no gbe_fork steamclient.dll (x86) in vendor — ColdClientLoader would refuse to launch with "Couldn\'t find the requested SteamClientDll"',
      mainExePath
    );
  }
  for (const drop of steamclientDrops) {
    const dest = join(mainExeDir, drop.name);
    if (existsSync(dest)) {
      log.debug('[drm-patcher] steamclient already present next to main exe', dest);
      continue;
    }
    try {
      copyFileSync(drop.src, dest);
      report.steamclientDllsCopied.push(dest);
      log.info('[drm-patcher] dropped gbe_fork steamclient next to main exe', dest);
    } catch (err) {
      log.warn(
        '[drm-patcher] failed to copy steamclient next to main exe',
        dest,
        (err as Error).message
      );
    }
  }

  if (settingsSrc && existsSync(settingsSrc)) {
    try {
      copyDirShallow(settingsSrc, join(mainExeDir, 'steam_settings'));
    } catch (err) {
      log.warn(
        '[drm-patcher] failed to copy steam_settings next to main exe',
        mainExeDir,
        (err as Error).message
      );
    }
  }

  // ── 5. ColdClientLoader (steamclient_loader_x{64,86}.exe + ini) ────
  //   ColdClientLoader's IPC environment synthesis is the workaround for
  //   `SteamAPI_Init` not tolerating a vanilla `CreateProcess` from a
  //   non-Steam-launcher parent — modern Steamworks titles like Postal
  //   Plus still need it, even with gbe_fork's `steam_api*.dll` swapped
  //   in. The loader ships as both `steamclient_loader_x64.exe` and
  //   `steamclient_loader_x86.exe`; spawning the matching arch is
  //   non-negotiable — the x64 build bails with "Arch of loader and
  //   requested exe are different" when handed a 32-bit main exe.
  //
  //   In the legacy dual-arch path (no `opts.arch`) we ship BOTH builds
  //   next to every install: legacy games that don't probe arch pick the
  //   first one Windows finds, modern ones use the matching one. In the
  //   arch-known flow we only drop the matching build — the unused arch's
  //   file is left off the install so a launcher-side arch-mismatch (e.g.
  //   a future dual-binary spawn heuristic) can't accidentally pick the
  //   wrong one.
  const wantX64Loader = !opts.arch || opts.arch === 'x64';
  const wantX86Loader = !opts.arch || opts.arch === 'x86';
  const loaderSrcX64 =
    opts.coldClientLoaderExePath !== undefined
      ? opts.coldClientLoaderExePath
      : resolveColdClientLoaderExePath();
  const loaderSrcX86 =
    opts.coldClientLoaderX86ExePath !== undefined
      ? opts.coldClientLoaderX86ExePath
      : resolveColdClientLoaderX86ExePath();
  const loaderTplSrc =
    opts.coldClientLoaderTemplatePath !== undefined
      ? opts.coldClientLoaderTemplatePath
      : resolveColdClientLoaderTemplatePath();
  const loaderDrops: Array<{ src: string | null; name: string }> = [];
  if (wantX64Loader) loaderDrops.push({ src: loaderSrcX64, name: 'steamclient_loader_x64.exe' });
  if (wantX86Loader) loaderDrops.push({ src: loaderSrcX86, name: 'steamclient_loader_x86.exe' });
  for (const drop of loaderDrops) {
    if (!drop.src || !existsSync(drop.src)) {
      if (drop.name === 'steamclient_loader_x64.exe') {
        log.warn(
          '[drm-patcher] no ColdClientLoader (x64) exe in vendor — game will spawn directly and may fail SteamAPI_Init',
          mainExePath
        );
      }
      // x86 missing is informational in arch-known x86 mode (we just
      // couldn't build the 32-bit loader); in dual-arch mode it's a hard
      // error for the same reason the x64 missing branch above is.
      continue;
    }
    const loaderDest = join(mainExeDir, drop.name);
    if (!existsSync(loaderDest)) {
      try {
        copyFileSync(drop.src, loaderDest);
        report.coldClientLoadersCopied.push(loaderDest);
        log.info('[drm-patcher] dropped ColdClientLoader', loaderDest);
      } catch (err) {
        log.warn(
          '[drm-patcher] failed to copy ColdClientLoader to',
          loaderDest,
          (err as Error).message
        );
      }
    } else {
      log.debug(
        '[drm-patcher] ColdClientLoader already present',
        loaderDest
      );
    }
  }

  if (loaderTplSrc && existsSync(loaderTplSrc)) {
    // Always re-render from the template and reconcile against the file
    // on disk. The previous "skip if exists" branch left stale inis from
    // earlier broken releases in place (e.g. SteamClientDll=steamclient.dll
    // when the loader now needs steamclient64.dll), so the loader would
    // pick up the bad ini and fail. Comparing content makes this idempotent
    // for already-correct installs *and* self-healing for older ones.
    const iniDest = join(mainExeDir, 'ColdClientLoader.ini');
    try {
      const tpl = readFileSync(loaderTplSrc, 'utf8');
      const rendered = tpl
        .replace(/\{\{EXE_NAME\}\}/g, basename(mainExePath))
        .replace(/\{\{APPID\}\}/g, String(appid));
      const current = existsSync(iniDest)
        ? readFileSync(iniDest, 'utf8')
        : null;
      if (current === rendered) {
        log.info('[drm-patcher] ColdClientLoader.ini up to date', iniDest);
      } else {
        writeFileSync(iniDest, rendered);
        report.coldClientIniWritten.push(iniDest);
        log.info('[drm-patcher] wrote ColdClientLoader.ini', iniDest);
      }
    } catch (err) {
      log.warn(
        '[drm-patcher] failed to write ColdClientLoader.ini',
        iniDest,
        (err as Error).message
      );
    }
  } else {
    log.warn(
      '[drm-patcher] no ColdClientLoader.ini template in vendor — skipping ini render',
      mainExePath
    );
  }

  log.info('[drm-patcher] done', {
    installDir,
    appid,
    unpacked: report.steamlessUnpacked.length,
    steamlessFailed: report.steamlessFailed.length,
    replaced: report.dllsReplaced.length,
    skipped: report.dllsSkipped.length,
    steamclientDllsCopied: report.steamclientDllsCopied.length,
    interfacesGenerated: report.interfacesGenerated.length,
    interfacesFailed: report.interfacesFailed.length,
    steamAppidTxt: report.steamAppidTxt,
    steamlessSkippedReason: report.steamlessSkippedReason,
    interfacesSkippedReason: report.interfacesSkippedReason,
    coldClientLoadersCopied: report.coldClientLoadersCopied.length,
    coldClientIniWritten: report.coldClientIniWritten.length,
  });
  return report;
}

// ── helpers ────────────────────────────────────────────────────────────

function isCandidateExe(name: string): boolean {
  if (!name.toLowerCase().endsWith('.exe')) return false;
  const lower = name.toLowerCase();
  // Skip helpers/installers/redists that won't have SteamStub and that
  // are expensive to scan (DirectX setup, VC redist, etc).
  if (
    lower.includes('unins') ||
    lower.includes('setup') ||
    lower.includes('redist') ||
    lower.includes('dxsetup') ||
    lower.includes('vcredist') ||
    lower.includes('directx') ||
    lower.includes('crashreport') ||
    lower.includes('eosbootstrapper') ||
    lower.includes('easyanticheat') ||
    lower.includes('ueprereqsetup')
  ) {
    return false;
  }
  // Steamless itself / our own backups — never re-process.
  if (lower.endsWith('.unpacked.exe') || lower.endsWith('.bak')) return false;
  return true;
}

const STEAM_API_DLL_RX = /^steam_api(64)?\.dll$/i;

/**
 * Recursively scan `installDir` for every `steam_api*.dll` regardless of
 * depth. Unreal Engine games bury the DLL many levels down — a typical
 * layout is `Engine/Binaries/ThirdParty/Steamworks/Steamv151/Win64/
 * steam_api64.dll` (six levels), and the prior depth-limited walker
 * compounded the miss by skip-listing the `Engine`/`Plugins` directories
 * outright. We deliberately drop both the depth budget and the skip list
 * here: there is no realistic install tree where a steam_api dll lives
 * somewhere we can afford not to look. Symlinks and dot-prefixed
 * directories (`.git`, `.vs`, …) are still skipped to bound the walk on
 * hostile trees.
 *
 * Every match is logged at info level — when gbe_fork silently fails to
 * take effect the count-zero log line is the first breadcrumb we want.
 */
export function scanForSteamApiDlls(installDir: string): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      if (ent.isSymbolicLink()) continue;
      const full = join(dir, ent.name);
      if (ent.isFile()) {
        if (STEAM_API_DLL_RX.test(ent.name)) {
          log.info('[drm-patcher] found steam_api dll', full);
          out.push(full);
        }
      } else if (ent.isDirectory()) {
        visit(full);
      }
    }
  };
  visit(installDir);
  return out;
}

function walkFiles(
  root: string,
  predicate: (name: string) => boolean
): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isFile()) {
        if (predicate(ent.name)) out.push(full);
      } else if (ent.isDirectory()) {
        if (SKIP_RECURSE.has(ent.name.toLowerCase())) continue;
        try {
          const st = statSync(full);
          if (st.isSymbolicLink()) continue;
        } catch {
          continue;
        }
        visit(full, depth + 1);
      }
    }
  };
  visit(root, 0);
  return out;
}

/**
 * Probe an install dir for the `.gbe_fork` marker that `applyDrmPatches`
 * drops next to every gbe_fork-swapped steam_api*.dll. The marker is the
 * authoritative signal that the patcher has already run on this tree —
 * Steamless may have been skipped (non-Windows host, missing CLI), but
 * the gbe_fork DLL swap is enough for most non-stubbed Steamworks titles
 * to boot standalone, so we treat the marker as "patched, don't rerun".
 *
 * Returns true when:
 *   - at least one steam_api*.dll lives in the tree without a sibling
 *     .gbe_fork marker, or
 *   - `mainExePath` is given and the per-install ColdClientLoader pieces
 *     (loader exe, ini, steamclient64.dll) are missing next to it —
 *     these landed AFTER the gbe_fork marker scheme, so trees patched
 *     before the loader integration carry markers but lack the loader.
 *     applyDrmPatches sections 4 & 5 are idempotent per-step so a re-run
 *     just drops the missing files without churning the DLL swap.
 *   - `mainExePath` is given and the existing ColdClientLoader.ini's
 *     `Exe=` line does not match `basename(mainExePath)`. Catches
 *     installs whose ini was rendered by an older launcher that pointed
 *     at the wrong sibling (e.g. the 32-bit exe before findGameExe
 *     learned the x64 promotion rule) — without this check the
 *     existence probes would report "fully patched" and the loader
 *     would read a stale `Exe=arma3.exe` and bail with "Arch of loader
 *     and requested exe are different".
 * Returns false when:
 *   - no steam_api*.dll exists (game isn't Steamworks-encumbered), or
 *   - every steam_api*.dll has its marker AND (if mainExePath given) the
 *     loader pieces are already in place AND the ini's `Exe=` matches.
 *
 * Note: trees patched by the legacy Goldberg pipeline carry a `.goldberg`
 * marker, which this function intentionally ignores — those installs are
 * treated as needing a re-patch so the gbe_fork DLL + interfaces.txt land.
 *
 * Read-only — safe to call at every launch and on every install on boot.
 */
export function needsDrmPatching(
  installDir: string,
  mainExePath?: string,
  options: { arch?: 'x86' | 'x64' } = {}
): boolean {
  if (!existsSync(installDir)) return false;
  const allDlls = scanForSteamApiDlls(installDir);
  // Legacy dual-arch (no `arch`) bails out when the install ships zero
  // Steamworks DLLs — there's nothing to swap and the original code path
  // never probed ColdClientLoader pieces in that case either. The
  // arch-known flow keeps going because the matching-arch loader +
  // steamclient probe still applies (an x86-only install that doesn't
  // ship Valve's `steam_api.dll` at all — e.g. Conflict: Desert Storm,
  // which never had a Steamworks build — still needs ColdClientLoader
  // dropped if the spawn flow decides one is required for the game's
  // Steamworks stub, and it ALWAYS needs `steamclient.dll` next to the
  // exe for the legacy LoadLibrary probe to satisfy).
  if (allDlls.length === 0 && !options.arch) return false;
  // When the caller passes `arch`, only the matching-arch DLLs need a
  // marker for the install to count as "patched". A dual-arch shipping
  // layout like Arma III legitimately ships BOTH Valve DLLs; we only
  // care that the one we're targeting has been swapped.
  const dlls = options.arch
    ? allDlls.filter((d) => {
        const lower = basename(d).toLowerCase();
        const isX64 = lower === 'steam_api64.dll';
        return options.arch === 'x64' ? isX64 : !isX64;
      })
    : allDlls;
  // In the legacy dual-arch flow we drop a `.gbe_fork` marker next to
  // every swapped `steam_api*.dll` so a later drm-boot scan can see at
  // a glance which Valve DLLs we replaced and skip them on re-patch.
  // Arch-known mode never swaps — it keeps Valve's original DLL and
  // drops only the experimental `steamclient*.dll` next to the main
  // exe — so the marker probe is meaningless there. Idempotency in
  // arch mode is provided by the per-step `if (!existsSync(...))`
  // guards inside applyDrmPatches itself; we gate the marker loop
  // on `!opts.arch` so a missing marker doesn't trigger an
  // infinite re-patch cycle.
  if (!options.arch) {
    for (const dll of dlls) {
      // Marker missing, OR marker present but the DLL is stock (a DD
      // -validate restored Valve's original over our swap and left the
      // marker behind) — either way the swap needs (re-)applying.
      if (!existsSync(dll + '.gbe_fork') || !isGbeForkDll(dll)) return true;
    }
  }
  // ColdClientLoader probes diverge between the legacy dual-arch flow
  // and the arch-known flow.
  //
  // Legacy dual-arch (no `arch`): drop BOTH bitness DLLs and the x64
  // ColdClientLoader next to the main exe. Every legacy probe must be
  // satisfied; trees patched before the x86 dll landed in vendor
  // (release prior to release-2026_05_19) keep their x64-only install
  // and need a re-patch to add the 32-bit steamclient probe.
  //
  // Arch-known (`arch` set): we now drop the matching-arch loader (we
  // used to skip ColdClientLoader entirely, but the x86 build of
  // ColdClientLoader has been in vendor since release-2026_05_19 and is
  // required for modern Steamworks titles like Postal Plus whose
  // `SteamAPI_Init` refuses to succeed without the IPC environment the
  // loader synthesises). The install still counts as "patched" when:
  //   (a) every matching-arch `steam_api*.dll` has its `.gbe_fork` marker
  //       (already enforced above), AND
  //   (b) the matching-arch `steamclient*.dll` sits next to the main exe
  //       (the `LoadLibrary("steamclient*.dll")` probe some titles do), AND
  //   (c) the matching-arch `steamclient_loader_*.exe` sits next to the
  //       main exe (otherwise the launch flow has no host process to
  //       exec the x86 main exe from, and falls back to direct spawn
  //       which then fails with "Unable to initialize SteamAPI").
  // Self-heal installs that pre-date the arch-aware spawn flow: those
  // trees carry only `steamclient_loader_x64.exe` next to an x86 main
  // exe, which would launch as an arch mismatch. Returning true here
  // triggers a re-patch that drops the missing matching-arch loader
  // alongside the existing one (the spawn flow correctly picks the
  // matching one).
  if (options.arch && mainExePath) {
    const mainExeDir = dirname(mainExePath);
    const matchingSteamclient =
      options.arch === 'x64' ? 'steamclient64.dll' : 'steamclient.dll';
    const matchingLoader =
      options.arch === 'x64'
        ? 'steamclient_loader_x64.exe'
        : 'steamclient_loader_x86.exe';
    if (!existsSync(join(mainExeDir, matchingSteamclient))) return true;
    if (!existsSync(join(mainExeDir, matchingLoader))) return true;
  }
  // Legacy dual-arch probes — skip when arch is known (handled above).
  if (options.arch) return false;
  if (mainExePath) {
    const mainExeDir = dirname(mainExePath);
    if (!existsSync(join(mainExeDir, 'steamclient_loader_x64.exe'))) return true;
    if (!existsSync(join(mainExeDir, 'ColdClientLoader.ini'))) return true;
    if (!existsSync(join(mainExeDir, 'steamclient64.dll'))) return true;
    // ColdClientLoader bails with "Couldn't find the requested
    // SteamClientDll" unless BOTH bitness dlls sit next to the loader,
    // so a tree missing the 32-bit one needs a re-patch even if every
    // other marker is in place. Trees patched before the x86 dll landed
    // in vendor (release prior to release-2026_05_19 integration) fall
    // into exactly this state.
    if (!existsSync(join(mainExeDir, 'steamclient.dll'))) return true;
    // Stale ini trap: a tree whose ColdClientLoader.ini still points at
    // the wrong main exe (e.g. the 32-bit sibling written before
    // findGameExe learned to prefer the _x64 / -x64 pair) looks fully
    // patched by the existence checks above, so applyDrmPatches would
    // never run and the loader would read the bad Exe= and bail with
    // "Arch of loader and requested exe are different". Detect that
    // here so a re-launch self-heals the ini without a manual wipe.
    if (iniExeLineMismatch(mainExeDir, basename(mainExePath))) return true;
  }
  return false;
}

/**
 * Return true when `ColdClientLoader.ini` next to the main exe is present
 * but its `Exe=` line does not point at `expectedExe`. We only sniff the
 * single `Exe=` key — the ini is a flat key=value file written from a
 * bundled template, so a full re-parse would just paper over the same
 * mismatch detection with more code. Returns false (no mismatch) when
 * the file is missing, unreadable, or doesn't carry an `Exe=` key — the
 * existence check above already gates on presence.
 */
function iniExeLineMismatch(mainExeDir: string, expectedExe: string): boolean {
  const iniPath = join(mainExeDir, 'ColdClientLoader.ini');
  let content: string;
  try {
    content = readFileSync(iniPath, 'utf8');
  } catch {
    return false;
  }
  const m = content.match(/^Exe=(.*)$/m);
  if (!m) return false;
  return m[1]!.trim() !== expectedExe;
}

/**
 * Copy every file at the top level of `src` into `dest` (one level deep).
 * gbe_fork's bundled steam_settings folder is flat in practice (a handful
 * of .txt / .ini configs) so we don't need a full recursive copy and a
 * shallow one keeps the implementation tiny. Existing files in `dest` are
 * preserved — important because `steam_interfaces.txt` is written into
 * `dest` BEFORE this copy runs and must not be clobbered.
 */
function copyDirShallow(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true }) as Dirent[];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const target = join(dest, ent.name);
    if (existsSync(target)) continue;
    copyFileSync(join(src, ent.name), target);
  }
}
