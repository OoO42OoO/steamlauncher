/**
 * Drop duplicate games (same `appid`) from the library view.
 *
 * `api.listAvailableAccounts()` returns one row per pool account, so a
 * game that several pool accounts own shows up multiple times. A real
 * case: Arma 3 owned by both an old account (lost access) and a fresh
 * one (bought again on recovery). The catalog and search are per-appid
 * — there is one row of UI per game, not per account — so the
 * duplicates just clutter both. The actual account used at launch is
 * picked from the kept row's `id`; whichever instance ends up there
 * is what `game:launch` will drive.
 *
 * Order is preserved so the rendering, sort, and any future "first
 * match wins" rules upstream of this call see the same sequence as
 * the backend.
 */
import type { PublicAccount } from '@steam-client/shared';

export function dedupeByAppid(entries: PublicAccount[]): PublicAccount[] {
  const seen = new Set<number>();
  const out: PublicAccount[] = [];
  for (const e of entries) {
    if (seen.has(e.appid)) continue;
    seen.add(e.appid);
    out.push(e);
  }
  return out;
}
