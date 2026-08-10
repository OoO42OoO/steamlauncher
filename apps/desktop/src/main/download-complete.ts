/**
 * "Is this install actually finished?" gate.
 *
 * DepotDownloader pre-allocates every file to its full size up-front
 * (`File.Create` + `fs.SetLength(TotalSize)`) BEFORE writing any chunk data,
 * then seeks and fills chunks in place. An interrupted download therefore
 * leaves full-size files whose unwritten regions read back as zeros — a 38 GB
 * `.pak` that is entirely 0x00 still has the "right" size on disk. Existence
 * and size checks (`hasGameExe`) can't tell such a hollow tree apart from a
 * finished one, so the app used to present a Play button on a corrupt install
 * (launch → `CreateProcess` → `ERROR_FILE_CORRUPT`).
 *
 * We fix that with an explicit marker written the moment DepotDownloader exits
 * cleanly. `isInstallComplete` treats the marker as authoritative; for installs
 * that predate the marker (or a genuinely partial download) it falls back to a
 * one-time zero-fill probe of the largest files — grandfathering complete
 * legacy installs by writing the marker, and caching a negative verdict so a
 * partial tree isn't re-walked on every library projection.
 */
import {
  existsSync,
  writeFileSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join } from 'node:path';
import log from 'electron-log/main.js';

/** Sentinel dropped in the install dir on a clean DepotDownloader exit. Not in
 *  any depot manifest, so DD never touches it and uninstall (whole-dir rm)
 *  removes it with the tree. */
export const COMPLETE_MARKER = '.download_complete';

/** Per-dir verdict cache for trees WITHOUT a marker, so the tree probe runs at
 *  most once per dir per session. A dir that later gains a marker
 *  short-circuits before this cache is consulted. */
const verdictCache = new Map<string, boolean>();

/** Record that the download in `dir` finished cleanly. Best-effort: on failure
 *  the next boot re-probes the tree and re-marks, so we never block on it. */
export function markDownloadComplete(dir: string, appid?: number): void {
  try {
    writeFileSync(
      join(dir, COMPLETE_MARKER),
      JSON.stringify({ appid: appid ?? null, at: new Date().toISOString() })
    );
    verdictCache.set(dir, true);
  } catch (err) {
    log.warn(
      '[install] could not write completion marker',
      dir,
      (err as Error).message
    );
  }
}

/** True if `dir` carries the clean-exit marker. Cheap (one stat). */
export function hasCompletionMarker(dir: string): boolean {
  return existsSync(join(dir, COMPLETE_MARKER));
}

/**
 * Authoritative "a finished install lives here" check for mergeInstallState /
 * rescanInstallRoot. Marker fast-path; otherwise a one-time zero-fill probe
 * that grandfathers complete legacy installs and caches partial ones negative.
 */
export function isInstallComplete(dir: string): boolean {
  if (hasCompletionMarker(dir)) return true;
  const cached = verdictCache.get(dir);
  if (cached !== undefined) return cached;
  const complete = looksFullyDownloaded(dir);
  if (complete) {
    // Legacy install predating markers — grandfather it so it keeps showing
    // as installed and we don't re-walk the tree next projection.
    markDownloadComplete(dir);
    return true;
  }
  verdictCache.set(dir, false);
  return false;
}

/** Drop a cached verdict so the next `isInstallComplete` re-probes (e.g. a
 *  resume just started — the tree will change). No-op once a marker exists. */
export function invalidateCompleteness(dir: string): void {
  verdictCache.delete(dir);
}

const PROBE_BYTES = 16;
/** A partial download can have the single biggest archive done but the next
 *  one still zeroed, so we probe the top few files, not just #1. */
const PROBE_TOP_N = 3;
/** Ignore small files — a stray zero-filled config proves nothing; only a
 *  large zero-filled archive means "download never finished". */
const PROBE_MIN_SIZE = 1024 * 1024; // 1 MB

/**
 * Heuristic for pre-marker installs: walk the tree, and if any of the largest
 * files is entirely zeros at three sampled offsets it's an unwritten DD
 * pre-allocation → the download never finished. Catches both a zeroed main
 * exe and a zeroed content archive (`.pak` / `.rpkg`) even when the launch exe
 * itself downloaded fine.
 */
function looksFullyDownloaded(dir: string): boolean {
  const largest = largestFiles(dir, PROBE_TOP_N);
  if (largest.length === 0) return false; // nothing on disk
  for (const f of largest) {
    if (f.size >= PROBE_MIN_SIZE && isZeroFilled(f.path, f.size)) return false;
  }
  return true;
}

function largestFiles(
  root: string,
  n: number
): Array<{ path: string; size: number }> {
  const out: Array<{ path: string; size: number }> = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const d = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue; // raced dir / perms — skip subtree
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          out.push({ path: p, size: statSync(p).size });
        } catch {
          // raced away — ignore
        }
      }
    }
  }
  out.sort((a, b) => b.size - a.size);
  return out.slice(0, n);
}

/** True if `path` reads as all-zeros at start, middle and end. A finished
 *  archive is not zero at three spread-out offsets; an unwritten
 *  pre-allocation is. Probe failures return false (never declare incomplete on
 *  a read error). */
function isZeroFilled(path: string, size: number): boolean {
  const offsets = [0, Math.floor(size / 2), Math.max(0, size - PROBE_BYTES)];
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(PROBE_BYTES);
    for (const off of offsets) {
      const read = readSync(fd, buf, 0, PROBE_BYTES, off);
      for (let i = 0; i < read; i++) {
        if (buf[i] !== 0) return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
