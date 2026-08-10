import type { PublicAccount, DownloadProgress } from '@steam-client/shared';

/**
 * Fold a download-progress event into a library snapshot, mirroring the
 * renderer's own reducer (App.tsx onProgress).
 *
 * The main process keeps an in-memory `library` cache that `library:list`
 * hands back verbatim. That cache is only rebuilt on sign-in — so without
 * folding progress in here, a game that finishes downloading mid-session
 * stays `not_installed` in the cache even though it's on disk. The next
 * `library:list` (e.g. the refresh fired after uninstalling a DIFFERENT
 * game) then returns that stale snapshot and the fully-installed game
 * reverts to `not_installed`, vanishing from the library / "installed
 * only" view. Keeping the cache in sync closes that gap the same way the
 * uninstall path already updates the cache.
 *
 * Pure and side-effect free so it can be unit-tested without booting main.
 */
export function applyDownloadProgress(
  entries: PublicAccount[],
  p: DownloadProgress
): PublicAccount[] {
  return entries.map((g) =>
    g.appid !== p.appid
      ? g
      : {
          ...g,
          status: p.done ? (p.error ? 'error' : 'installed') : 'downloading',
          downloadPercent: p.done ? (p.error ? null : 100) : p.percent,
          downloadStage: p.done ? null : p.stage ?? g.downloadStage,
          downloadError: p.done ? p.error ?? null : null,
          downloadErrorPlatforms: p.done ? p.errorPlatforms ?? null : null,
          guardHint: p.done ? null : p.guardHint ?? null,
          downloadBytesDownloaded: p.done
            ? null
            : p.bytesDownloaded ?? g.downloadBytesDownloaded,
          downloadBytesTotal: p.done ? null : p.bytesTotal ?? g.downloadBytesTotal,
        }
  );
}
