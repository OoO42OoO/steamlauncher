import { describe, expect, it } from 'vitest';
import { applyDownloadProgress } from './library-cache';
import type { PublicAccount, DownloadProgress } from '@steam-client/shared';

function acc(over: Partial<PublicAccount> = {}): PublicAccount {
  return {
    id: 'acc_1',
    appid: 6060,
    game_name: 'STAR WARS Battlefront II',
    iconUrl: null,
    logoUrl: null,
    min_trust_level: 0,
    locked: false,
    status: 'not_installed',
    downloadPercent: null,
    downloadStage: null,
    guardHint: null,
    downloadError: null,
    downloadErrorPlatforms: null,
    downloadBytesDownloaded: null,
    downloadBytesTotal: null,
    ...over,
  };
}

const progress = (over: Partial<DownloadProgress> = {}): DownloadProgress => ({
  appid: 6060,
  percent: 0,
  done: false,
  ...over,
});

describe('applyDownloadProgress', () => {
  it('flips the matching game to installed on a successful done event', () => {
    // The regression: a game that finished downloading must not stay
    // not_installed in the cache, or a later library:list makes it vanish.
    const lib = [acc({ appid: 6060, status: 'not_installed' })];
    const [g] = applyDownloadProgress(lib, progress({ done: true, percent: 100 }));
    expect(g.status).toBe('installed');
    expect(g.downloadPercent).toBe(100);
    expect(g.downloadStage).toBeNull();
    expect(g.downloadError).toBeNull();
  });

  it('leaves other games untouched (uninstalling one keeps the other)', () => {
    // Core of the reported bug: progress for 6060 must not touch 6000.
    const lib = [
      acc({ id: 'a', appid: 6000, game_name: 'Republic Commando', status: 'installed' }),
      acc({ id: 'b', appid: 6060, status: 'not_installed' }),
    ];
    const out = applyDownloadProgress(lib, progress({ appid: 6060, done: true }));
    expect(out[0]).toBe(lib[0]); // identity preserved — genuinely untouched
    expect(out[0].status).toBe('installed');
    expect(out[1].status).toBe('installed');
  });

  it('marks downloading with live percent/stage on in-flight events', () => {
    const lib = [acc({ status: 'not_installed' })];
    const [g] = applyDownloadProgress(
      lib,
      progress({ percent: 42, stage: { phase: 'downloading', current: 1, total: 3 } })
    );
    expect(g.status).toBe('downloading');
    expect(g.downloadPercent).toBe(42);
    expect(g.downloadStage).toEqual({ phase: 'downloading', current: 1, total: 3 });
  });

  it('maps a terminal error event to error status', () => {
    const lib = [acc({ status: 'downloading' })];
    const [g] = applyDownloadProgress(
      lib,
      progress({ done: true, error: 'no_license', errorPlatforms: ['windows'] })
    );
    expect(g.status).toBe('error');
    expect(g.downloadError).toBe('no_license');
    expect(g.downloadErrorPlatforms).toEqual(['windows']);
    expect(g.downloadPercent).toBeNull();
  });

  it('preserves the previous stage when an in-flight event omits it', () => {
    const lib = [
      acc({ status: 'downloading', downloadStage: { phase: 'validating', current: 2, total: 2 } }),
    ];
    const [g] = applyDownloadProgress(lib, progress({ percent: 55 }));
    expect(g.downloadStage).toEqual({ phase: 'validating', current: 2, total: 2 });
  });

  it('carries byte counters on in-flight events and clears them on done', () => {
    const lib = [acc({ status: 'downloading' })];
    const mid = applyDownloadProgress(
      lib,
      progress({ percent: 20, bytesDownloaded: 1000, bytesTotal: 5000 })
    );
    expect(mid[0].downloadBytesDownloaded).toBe(1000);
    expect(mid[0].downloadBytesTotal).toBe(5000);
    const fin = applyDownloadProgress(mid, progress({ done: true }));
    expect(fin[0].downloadBytesDownloaded).toBeNull();
    expect(fin[0].downloadBytesTotal).toBeNull();
  });

  it('returns the list unchanged when no appid matches', () => {
    const lib = [acc({ appid: 6060, status: 'installed' })];
    const out = applyDownloadProgress(lib, progress({ appid: 999, done: true }));
    expect(out[0]).toBe(lib[0]);
  });
});
