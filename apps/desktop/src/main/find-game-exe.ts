import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

// Steam depots routinely ship Valve's own helper binaries plus assorted
// redists / launchers. Without a denylist the largest-.exe heuristic will
// happily pick Steam.exe (the DRM bootstrap) and our Play button ends up
// booting Steam instead of the game.
const SKIP_EXACT_NAMES = new Set<string>([
  'steam.exe',
  'steamerrorreporter.exe',
  'steamerrorreporter64.exe',
  'steamservice.exe',
  'steamservice_x64.exe',
  'steamwebhelper.exe',
  'steamtours.exe',
]);

const SKIP_NAME_FRAGMENTS = [
  'unins',
  'setup',
  'install',
  'redist',
  'vc_redist',
  'vcredist',
  'directx',
  'dxsetup',
  'dotnet',
  'crashhandler',
  'crashreport',
  'crashreporter',
  'eossdk',
  'easyanticheat',
  'eac',
  'launcher_setup',
  'ueprereqsetup',
  'bemultiplayer',
  'be_service',
  'steam_emu',
  'steam_api',
];

// Directories we never recurse into — Unreal asset trees in particular
// contain thousands of files but never the main game executable.
const SKIP_RECURSE_DIRS = new Set<string>([
  'content',
  'engine',
  'plugins',
  'saved',
  '_commonredist',
  'commonredist',
  'redist',
  'crashreportclient',
]);

// Steam DRM bootstrap stubs are typically <1MB; the real packaged exe is
// tens to hundreds of MB. We treat a root-level exe smaller than this
// limit as suspicious when there is a much larger candidate elsewhere.
const STUB_BYTES = 2 * 1024 * 1024;
const REAL_EXE_BYTES = 10 * 1024 * 1024;

// Some titles ship both an x86 and an x64 exe in the install root with a
// shared basename, e.g. Arma III (`arma3.exe` + `arma3_x64.exe`). The
// x86 one is historically what Steam launches by default — but our
// launcher spawns the 64-bit ColdClientLoader, which then refuses to
// exec a 32-bit exe with the "Arch of loader and requested exe are
// different" nag. When we can prove the x64 sibling is real (>= the
// REAL_EXE_BYTES threshold) AND it is strictly larger than its x86 twin,
// promote the x64 sibling to the top of the candidate list.
const X64_SIBLING_SUFFIXES = ['_x64', '-x64', '64'] as const;

// Walk this deep below the install dir. Covers the canonical Unreal
// layout `<GameName>/Binaries/Win64/<GameName>-Win64-Shipping.exe`.
const MAX_WALK_DEPTH = 3;

export type UEVariant = 'shipping' | 'test' | 'plain';

export type ExeCandidate = {
  path: string;
  size: number;
  name: string;
  depth: number;
  siblingsHaveSteamAppid: boolean;
  siblingsHaveSteamApiDll: boolean;
  nameScore: number;
  ueVariant: UEVariant | null;
  isLikelyStub: boolean;
  /**
   * True when this exe is the `*_x64` sibling of a smaller x86 exe in
   * the same directory and the x64 file is large enough to be a real
   * packaged binary (>= REAL_EXE_BYTES). Examples: Arma III ships
   * `arma3.exe` + `arma3_x64.exe` — the x86 one is what Steam launches
   * by default, the x64 one is what we want so our 64-bit
   * ColdClientLoader does not bail with an arch-mismatch nag.
   */
  x64Dominant: boolean;
  /**
   * True when the launcher should demote this candidate below
   * non-shadowed alternatives. Two real-world cases both flip this on:
   *
   *   (a) This candidate is the original exe (e.g. `arma3_x64.exe`)
   *       and a Steamless output sits next to it
   *       (`arma3_x64.exe.unpacked.exe`) with no `.bak` to mark a
   *       completed swap. The original still carries SteamStub and
   *       would dial `steam://run/<appid>` and re-launch through
   *       real Steam. The unpacked sibling is the safe pick.
   *
   *   (b) This candidate IS the `.unpacked.exe` sibling but the
   *       original's `.bak` exists — meaning a prior swap completed
   *       and Steamless was re-run later, leaving this `.unpacked.exe`
   *       behind as dead output. The launcher should pick the
   *       original (now the clean, post-swap binary) instead.
   *
   * In both cases the shadowed candidate is kept in `candidates` for
   * log diagnostics, just demoted in the ranker.
   */
  unpackedShadowed: boolean;
};

export type FindGameExeResult = {
  path: string;
  reason: string;
  candidates: ExeCandidate[];
};

function shouldSkipExe(name: string): boolean {
  const lower = name.toLowerCase();
  if (SKIP_EXACT_NAMES.has(lower)) return true;
  return SKIP_NAME_FRAGMENTS.some((f) => lower.includes(f));
}

/**
 * Strip the canonical x64 marker suffix from an exe basename (case-insensitive,
 * .exe already removed by the caller). Returns the bare basename when the
 * name does not end in a recognised x64 marker. Matching is suffix-based so
 * `arma3_x64` → `arma3` and `Game-x64` → `Game`, but plain `Game64` does
 * NOT match — that pattern is too ambiguous (would collide with versioned
 * exes like `ac4_1.06.exe`).
 */
function stripX64Suffix(basename: string): string | null {
  const lower = basename.toLowerCase();
  for (const suf of X64_SIBLING_SUFFIXES) {
    if (lower.endsWith(suf) && lower.length > suf.length) {
      return basename.slice(0, basename.length - suf.length);
    }
  }
  return null;
}

/**
 * Group exe candidates by the directory they live in, indexed by their
 * basename WITHOUT the `.exe` extension. Used by the x64-pair detector
 * to find `<basename>` + `<basename>_x64` siblings living side by side.
 */
function groupByDirAndBasename(
  candidates: ExeCandidate[],
): Map<string, Map<string, ExeCandidate[]>> {
  const out = new Map<string, Map<string, ExeCandidate[]>>();
  for (const c of candidates) {
    const slash = c.path.lastIndexOf(sep);
    const dir = slash >= 0 ? c.path.slice(0, slash) : '';
    const dot = c.name.toLowerCase().lastIndexOf('.exe');
    const base = dot >= 0 ? c.name.slice(0, dot) : c.name;
    let bucket = out.get(dir);
    if (!bucket) {
      bucket = new Map();
      out.set(dir, bucket);
    }
    const arr = bucket.get(base);
    if (arr) arr.push(c);
    else bucket.set(base, [c]);
  }
  return out;
}

function normaliseExeName(s: string): string {
  return s
    .toLowerCase()
    // Steamless writes its output as `<basename>.exe.unpacked.exe` —
    // strip that compound suffix BEFORE the .exe strip so the unpacked
    // file gets the same name-score as the original. Otherwise the
    // original (which keeps SteamStub until the drm-patcher finishes
    // the swap) outscores the unpacked on name match and the launcher
    // picks the SteamStub-wrapped one, which then dials
    // `steam://run/<appid>` and triggers a Steam-side re-launch loop.
    .replace(/\.unpacked\.exe$/, '')
    .replace(/\.exe$/, '')
    .replace(/[^a-z0-9]/g, '');
}

function nameSimilarity(exeName: string, gameName: string): number {
  const a = normaliseExeName(exeName);
  const b = normaliseExeName(gameName);
  if (!a || !b) return 0;
  if (a === b) return 1000;
  if (a.includes(b) || b.includes(a)) return 500;
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
    prefix++;
  }
  return prefix >= 4 ? prefix : 0;
}

/**
 * Unreal Engine 4/5 packages the main game binary at the canonical path
 *   <GameName>/Binaries/<WinXX>/<GameName>-WinXX-Shipping.exe
 * with two common variants: `-WinXX-Test.exe` (test build) and the
 * suffix-less `<GameName>.exe`. The Steam DRM bootstrap stub at the
 * install-dir root is intentionally named `<GameName>.exe` to fool
 * users — picking the UE exe inside `Binaries/WinXX/` is the only
 * reliable disambiguator.
 */
function detectUEVariant(absPath: string): UEVariant | null {
  const parts = absPath.split(sep);
  if (parts.length < 3) return null;
  const file = parts[parts.length - 1]!.toLowerCase();
  const win = parts[parts.length - 2]!.toLowerCase();
  const bin = parts[parts.length - 3]!.toLowerCase();
  if (bin !== 'binaries') return null;
  if (!/^win(32|64|gdk|arm64)$/.test(win)) return null;
  if (/-shipping\.exe$/.test(file)) return 'shipping';
  if (/-test\.exe$/.test(file)) return 'test';
  return 'plain';
}

/**
 * Find the game's main executable inside `installDir`. We don't have a
 * manifest (DD doesn't emit one), so we walk a few levels deep, collect
 * every .exe that doesn't look like a Steam helper / installer / redist,
 * and rank by Unreal pattern → anti-stub heuristic → Steamworks marker →
 * name match → depth → size.
 *
 * UE pattern takes top priority because Steam's DRM bootstrap stub is
 * deliberately disguised as `<GameName>.exe` at the install-dir root;
 * largest-.exe / name-match heuristics happily picked the 1 MB stub,
 * which in turn relaunches Steam — exactly the bug we're fixing.
 *
 * Returns the absolute path plus the ranked candidate list and a short
 * reason string so the caller can log "why this exe". Throws if no
 * candidate exists.
 */
export function findGameExe(
  installDir: string,
  gameName?: string,
): FindGameExeResult {
  const collected: ExeCandidate[] = [];

  const visit = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    const siblingsHaveSteamAppid = entries.some(
      (e) => e.isFile() && e.name.toLowerCase() === 'steam_appid.txt',
    );
    const siblingsHaveSteamApiDll = entries.some((e) => {
      if (!e.isFile()) return false;
      const lower = e.name.toLowerCase();
      return lower === 'steam_api.dll' || lower === 'steam_api64.dll';
    });
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isFile() && ent.name.toLowerCase().endsWith('.exe')) {
        if (shouldSkipExe(ent.name)) continue;
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          continue;
        }
        collected.push({
          path: full,
          size,
          name: ent.name,
          depth,
          siblingsHaveSteamAppid,
          siblingsHaveSteamApiDll,
          nameScore: gameName ? nameSimilarity(ent.name, gameName) : 0,
          ueVariant: detectUEVariant(full),
          isLikelyStub: false,
          x64Dominant: false,
          unpackedShadowed: false,
        });
      } else if (ent.isDirectory() && depth < MAX_WALK_DEPTH) {
        if (SKIP_RECURSE_DIRS.has(ent.name.toLowerCase())) continue;
        visit(full, depth + 1);
      }
    }
  };
  visit(installDir, 0);

  if (collected.length === 0) {
    throw new Error(`no .exe found in install dir ${installDir}`);
  }

  // Anti-stub second pass: a root-level exe smaller than STUB_BYTES is
  // very likely the Steam DRM bootstrap when either (a) a real (>10 MB)
  // exe lives elsewhere in the tree, or (b) a steam_api*.dll sits next
  // to it (the DLL is what stubs link against to call back into Steam).
  const hasRealElsewhere = collected.some(
    (c) => c.size >= REAL_EXE_BYTES && c.depth > 0,
  );
  for (const c of collected) {
    if (c.depth === 0 && c.size < STUB_BYTES) {
      if (hasRealElsewhere || c.siblingsHaveSteamApiDll) {
        c.isLikelyStub = true;
      }
    }
  }

  // x64-sibling promotion: when `<basename>.exe` and `<basename>_x64.exe`
  // sit in the same directory AND the x64 sibling is at least
  // REAL_EXE_BYTES big AND strictly larger than its x86 twin, mark the
  // x64 sibling as dominant. The x86 twin keeps its normal scoring
  // (incl. `isLikelyStub` if it qualifies) so other heuristics still win
  // when the x64 file is too small to be a real packaged binary.
  for (const bucket of groupByDirAndBasename(collected).values()) {
    for (const [base, members] of bucket) {
      const x64Base = stripX64Suffix(base);
      if (x64Base === null) continue;
      const x86Siblings = bucket.get(x64Base);
      if (!x86Siblings || x86Siblings.length === 0) continue;
      for (const x64 of members) {
        if (x64.size < REAL_EXE_BYTES) continue;
        if (x86Siblings.every((x86) => x86.size < x64.size)) {
          x64.x64Dominant = true;
        }
      }
    }
  }

  // Steamless-output shadow detection. Two states the ranker needs to
  // distinguish, both expressed as `unpackedShadowed = true`:
  //
  //   (a) The original exe has an `.unpacked.exe` sibling but no
  //       `.bak`. Steamless ran but the swap never finished, so the
  //       original still carries SteamStub. Demote the original so the
  //       ranker picks the unpacked sibling — otherwise the launcher
  //       would spawn the stub-wrapped binary, which dials
  //       `steam://run/<appid>` and triggers a Steam-side re-launch
  //       loop.
  //   (b) The candidate IS the `.unpacked.exe` and the original's
  //       `.bak` exists. A prior swap completed (so the original
  //       slot is the clean binary) and Steamless was re-run on it
  //       later, leaving this `.unpacked.exe` as dead output. Demote
  //       the leftover so the ranker picks the original.
  for (const c of collected) {
    const lowerName = c.name.toLowerCase();
    if (lowerName.endsWith('.unpacked.exe')) {
      // Case (b): this is a Steamless output. Look for the original
      // slot's `.bak` to decide if a prior swap completed.
      const originalSlot = c.path.slice(0, -'.unpacked.exe'.length);
      c.unpackedShadowed = existsSync(originalSlot + '.bak');
      continue;
    }
    // Case (a): this is the original-slot exe. Demote if its
    // `.unpacked.exe` sibling exists and no `.bak` marks a swap.
    const hasUnpacked = existsSync(c.path + '.unpacked.exe');
    const hasBak = existsSync(c.path + '.bak');
    c.unpackedShadowed = hasUnpacked && !hasBak;
  }

  const ranked = [...collected].sort((a, b) => {
    const aShip = a.ueVariant === 'shipping';
    const bShip = b.ueVariant === 'shipping';
    if (aShip !== bShip) return aShip ? -1 : 1;
    const aTest = a.ueVariant === 'test';
    const bTest = b.ueVariant === 'test';
    if (aTest !== bTest) return aTest ? -1 : 1;
    const aUE = a.ueVariant !== null;
    const bUE = b.ueVariant !== null;
    if (aUE !== bUE) return aUE ? -1 : 1;
    if (a.isLikelyStub !== b.isLikelyStub) return a.isLikelyStub ? 1 : -1;
    if (a.x64Dominant !== b.x64Dominant) return a.x64Dominant ? -1 : 1;
    if (a.unpackedShadowed !== b.unpackedShadowed)
      return a.unpackedShadowed ? 1 : -1;
    if (a.siblingsHaveSteamAppid !== b.siblingsHaveSteamAppid)
      return a.siblingsHaveSteamAppid ? -1 : 1;
    if (a.nameScore !== b.nameScore) return b.nameScore - a.nameScore;
    if (a.depth !== b.depth) return a.depth - b.depth;
    return b.size - a.size;
  });

  const chosen = ranked[0]!;
  return { path: chosen.path, reason: describeChoice(chosen), candidates: ranked };
}

function describeChoice(c: ExeCandidate): string {
  const tags: string[] = [];
  if (c.ueVariant === 'shipping') tags.push('UE Shipping');
  else if (c.ueVariant === 'test') tags.push('UE Test');
  else if (c.ueVariant === 'plain') tags.push('UE plain');
  if (c.x64Dominant) tags.push('x64 sibling');
  if (c.unpackedShadowed) tags.push('shadowed by Steamless output');
  if (c.siblingsHaveSteamAppid) tags.push('steam_appid.txt sibling');
  if (c.nameScore >= 500) tags.push('name match');
  if (tags.length === 0) tags.push(`largest at depth ${c.depth}`);
  return tags.join(' + ');
}

/** Cheap "does this dir contain a plausible game binary?" probe. */
export function hasGameExe(installDir: string): boolean {
  try {
    findGameExe(installDir);
    return true;
  } catch {
    return false;
  }
}
