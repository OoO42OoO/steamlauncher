/**
 * Tests for steam-app-info.ts.
 *
 * Two surface areas:
 *   1. parseLaunchInfo — pure function over appinfo VDF trees. Heavy
 *      coverage here because the real service sits on top of it.
 *   2. SteamAppInfoService — exercised via the `fetcher` injection seam
 *      and a temporary cache file. We never open a real Steam connection.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    setName: () => {},
    getPath: (key: string) => {
      // Mirror the real layout: every requested path resolves under
      // a single tmp root so the service can write a cache there.
      if (key === 'userData' || key === 'cache' || key === 'logs' || key === 'data' || key === 'state')
        return '/tmp/steam-client-test';
      return '/tmp/steam-client-test';
    },
  },
}));
vi.mock('electron-log/main.js', () => ({
  default: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    transports: { file: { resolvePathFn: null } },
  },
}));

import {
  parseGenreIds,
  parseLaunchInfo,
  SteamAppInfoService,
  type LaunchInfo,
  type SteamClientHandle,
} from './steam-app-info';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'steam-app-info-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── parseLaunchInfo fixtures ──────────────────────────────────────────

const APPINFO_SWRC = {
  appid: 6000,
  common: {
    name: 'STAR WARS Republic Commando',
    type: 'Game',
    oslist: 'windows',
  },
  config: {
    installdir: 'Star Wars Republic Commando',
    launch: {
      '0': {
        executable: 'GameData\\System\\SWRepublicCommando.exe',
        config: {
          oslist: 'windows',
          osarch: '32',
        },
      },
    },
  },
};

const APPINFO_DUAL_ARCH = {
  appid: 107400,
  config: {
    installdir: 'ARK',
    launch: {
      '0': {
        executable: 'ShooterGame\\Binaries\\Win64\\ShooterGame.exe',
        config: { oslist: 'windows', osarch: '64' },
      },
      '1': {
        executable: 'ShooterGame\\Binaries\\Win32\\ShooterGame.exe',
        config: { oslist: 'windows', osarch: '32' },
      },
    },
  },
};

const APPINFO_MAC_ONLY = {
  appid: 12345,
  config: {
    installdir: 'MacGame',
    launch: {
      '0': {
        executable: 'MacGame.app/Contents/MacOS/MacGame',
        config: { oslist: 'macos', osarch: '64' },
      },
    },
  },
};

const APPINFO_MIXED_NUMS = {
  appid: 7,
  config: {
    installdir: 'Mixed',
    launch: {
      '5': {
        executable: 'skipped',
        config: { oslist: 'linux' },
      },
      '0': {
        executable: 'good/Game.exe',
        config: { oslist: 'windows', osarch: '64' },
      },
      '3': {
        executable: 'old/Game.exe',
        config: { oslist: 'windows', osarch: '32' },
      },
    },
  },
};

const APPINFO_WITH_COMMA_SEPARATED_OSLIST = {
  appid: 11,
  config: {
    installdir: 'Multi',
    launch: {
      '0': {
        executable: 'game.exe',
        config: { oslist: 'windows,macos,linux', osarch: '64' },
      },
    },
  },
};

// ── parseLaunchInfo: pure-function tests ───────────────────────────────

describe('parseLaunchInfo', () => {
  it('returns null for null / non-object input', () => {
    expect(parseLaunchInfo(null)).toBeNull();
    expect(parseLaunchInfo(undefined)).toBeNull();
    expect(parseLaunchInfo('garbage')).toBeNull();
    expect(parseLaunchInfo(42)).toBeNull();
  });

  it('returns null when config block is missing', () => {
    expect(parseLaunchInfo({ appid: 6000, common: {} })).toBeNull();
  });

  it('returns null when installdir is empty', () => {
    expect(
      parseLaunchInfo({ config: { installdir: '', launch: { 0: {} } } }),
    ).toBeNull();
  });

  it('returns null when launch block is missing', () => {
    expect(
      parseLaunchInfo({ config: { installdir: 'X', launch: {} } }),
    ).toBeNull();
  });

  it('parses a single-arch windows launch (SW Republic Commando case)', () => {
    expect(parseLaunchInfo(APPINFO_SWRC)).toEqual({
      installdir: 'Star Wars Republic Commando',
      launchExe: 'GameData\\System\\SWRepublicCommando.exe',
      arch: 'x86',
    });
  });

  it('prefers x64 when both arches are present', () => {
    const got = parseLaunchInfo(APPINFO_DUAL_ARCH)!;
    expect(got.arch).toBe('x64');
    expect(got.launchExe).toContain('Win64');
  });

  it('skips non-windows launch entries', () => {
    const got = parseLaunchInfo(APPINFO_MAC_ONLY);
    expect(got).toBeNull();
  });

  it('accepts comma-separated oslist (windows,macos,linux)', () => {
    const got = parseLaunchInfo(APPINFO_WITH_COMMA_SEPARATED_OSLIST)!;
    expect(got).toEqual({
      installdir: 'Multi',
      launchExe: 'game.exe',
      arch: 'x64',
    });
  });

  it('accepts a windows entry without osarch (arch null, PE-detected later)', () => {
    const got = parseLaunchInfo({
      config: {
        installdir: 'X',
        launch: {
          '0': {
            executable: 'noarch.exe',
            config: { oslist: 'windows' },
          },
        },
      },
    });
    expect(got).toEqual({ installdir: 'X', launchExe: 'noarch.exe', arch: null });
  });

  it('accepts a bare executable with no config block (old titles like Republic Commando)', () => {
    // Verbatim shape of what Steam PICS returns for appid 6000: a single
    // launch entry carrying only `executable`, plus a windows common.oslist.
    // This must resolve to the real game exe, not fall through to null (which
    // sent the DRM patcher to the LaunchRC.exe launcher wrapper).
    const got = parseLaunchInfo({
      common: { name: 'STAR WARS Republic Commando', oslist: 'windows' },
      config: {
        installdir: 'Star Wars Republic Commando',
        launch: { '0': { executable: 'GameData\\System\\SWRepublicCommando.exe' } },
      },
    });
    expect(got).toEqual({
      installdir: 'Star Wars Republic Commando',
      launchExe: 'GameData\\System\\SWRepublicCommando.exe',
      arch: null,
    });
  });

  it('drops a bare executable when the app itself is not windows', () => {
    const got = parseLaunchInfo({
      common: { oslist: 'macos' },
      config: {
        installdir: 'X',
        launch: { '0': { executable: 'mac.app' } },
      },
    });
    expect(got).toBeNull();
  });

  it('prefers a known-arch windows entry over a bare no-config one', () => {
    const got = parseLaunchInfo({
      common: { oslist: 'windows' },
      config: {
        installdir: 'X',
        launch: {
          '0': { executable: 'bare.exe' },
          '1': { executable: 'game64.exe', config: { oslist: 'windows', osarch: '64' } },
        },
      },
    })!;
    expect(got.launchExe).toBe('game64.exe');
    expect(got.arch).toBe('x64');
  });

  it('ignores non-windows entries when keys are non-sequential', () => {
    const got = parseLaunchInfo(APPINFO_MIXED_NUMS)!;
    // Win64 wins on arch, and the linux entry at key 5 must be skipped.
    expect(got.arch).toBe('x64');
    expect(got.launchExe).toBe('good/Game.exe');
  });

  it('treats numeric-key launch as a string-keyed object (Steam convention)', () => {
    // Many parsers int-convert numeric VDF keys; ensure we still cope.
    const got = parseLaunchInfo({
      config: {
        installdir: 'Edge',
        launch: {
          0: {
            executable: 'edge.exe',
            config: { oslist: 'windows', osarch: '64' },
          },
        },
      },
    });
    expect(got).toEqual({
      installdir: 'Edge',
      launchExe: 'edge.exe',
      arch: 'x64',
    });
  });

  it('handles the osarch=32 → x86 mapping explicitly', () => {
    const got = parseLaunchInfo({
      config: {
        installdir: 'X',
        launch: {
          '0': {
            executable: 'x86.exe',
            config: { oslist: 'windows', osarch: '32' },
          },
        },
      },
    });
    expect(got).toEqual({
      installdir: 'X',
      launchExe: 'x86.exe',
      arch: 'x86',
    });
  });
});

// ── SteamAppInfoService: cache + fetcher seam ───────────────────────

describe('SteamAppInfoService', () => {
  function makeService(
    fetcher: (id: number) => Promise<LaunchInfo | null>
  ): SteamAppInfoService {
    return new SteamAppInfoService({
      cachePath: join(tmpDir, 'cache.json'),
      fetcher,
      readOnly: false,
    });
  }

  it('returns null immediately when fetcher yields null', async () => {
    const svc = makeService(async () => null);
    const got = await svc.getLaunchInfo(999);
    expect(got).toBeNull();
  });

  it('caches a successful fetcher result and replays it from disk', async () => {
    const expected: LaunchInfo = {
      installdir: 'Star Wars Republic Commando',
      launchExe: 'GameData\\System\\SWRepublicCommando.exe',
      arch: 'x86',
    };
    let calls = 0;
    const svc = makeService(async (id) => {
      calls++;
      expect(id).toBe(6000);
      return expected;
    });

    const first = await svc.getLaunchInfo(6000);
    expect(first).toEqual(expected);
    expect(calls).toBe(1);

    // Re-instantiate: should read from disk without re-fetching.
    const svc2 = new SteamAppInfoService({
      cachePath: join(tmpDir, 'cache.json'),
      fetcher: async () => {
        throw new Error('should not be called');
      },
      readOnly: true,
    });
    const second = await svc2.getLaunchInfo(6000);
    expect(second).toEqual(expected);
    expect(calls).toBe(1); // unchanged — only the original fetcher ran
    void svc2;
  });

  it('uses put() to overwrite cache (force-refresh path)', async () => {
    const svc = makeService(async () => ({
      installdir: 'X',
      launchExe: 'old.exe',
      arch: 'x86',
    }));
    const got1 = await svc.getLaunchInfo(42);
    expect(got1?.launchExe).toBe('old.exe');
    svc.put(42, {
      installdir: 'X',
      launchExe: 'fresh.exe',
      arch: 'x64',
    });
    const got2 = await svc.getLaunchInfo(42);
    expect(got2?.launchExe).toBe('fresh.exe');
    expect(got2?.arch).toBe('x64');
  });

  it('does not re-fetch when TTL has not elapsed', async () => {
    let calls = 0;
    const svc = makeService(async () => {
      calls++;
      return {
        installdir: 'X',
        launchExe: 'game.exe',
        arch: 'x64',
      };
    });
    await svc.getLaunchInfo(1);
    await svc.getLaunchInfo(1);
    await svc.getLaunchInfo(1);
    expect(calls).toBe(1);
  });

  it('rejects negative or zero appids without calling fetcher', async () => {
    let calls = 0;
    const svc = makeService(async () => {
      calls++;
      return null;
    });
    expect(await svc.getLaunchInfo(0)).toBeNull();
    expect(await svc.getLaunchInfo(-1)).toBeNull();
    expect(await svc.getLaunchInfo(1.5)).toBeNull();
    expect(calls).toBe(0);
  });

  it('propagates fetcher errors as null and does not mutate the cache', async () => {
    const cachePath = join(tmpDir, 'err-cache.json');
    let calls = 0;
    const svc = makeService(async () => {
      calls++;
      throw new Error('network_down');
    });
    // Override cachePath via constructor since makeService uses defaults.
    (svc as unknown as { cachePath: string }).cachePath = cachePath;
    const got = await svc.getLaunchInfo(6000);
    expect(got).toBeNull();
    expect(calls).toBe(1);
    // No cache file should have been written on failure.
    expect(existsSync(cachePath)).toBe(false);
  });

  it('subsequent getLaunchInfo retries after a fetcher failure (no permanent poisoning)', async () => {
    let calls = 0;
    const svc = makeService(async (id) => {
      calls++;
      if (calls === 1) throw new Error('flake');
      return {
        installdir: 'Recovered',
        launchExe: 'r.exe',
        arch: 'x86' as const,
      };
    });
    expect(await svc.getLaunchInfo(11)).toBeNull();
    const second = await svc.getLaunchInfo(11);
    expect(second).toEqual({
      installdir: 'Recovered',
      launchExe: 'r.exe',
      arch: 'x86',
    });
    expect(calls).toBe(2);
  });

  it('survives a malformed cache file by starting fresh', async () => {
    writeFileSync(join(tmpDir, 'cache.json'), '{not-json');
    const svc = new SteamAppInfoService({
      cachePath: join(tmpDir, 'cache.json'),
      fetcher: async (id) => ({
        installdir: 'Y',
        launchExe: 'y.exe',
        arch: 'x64',
      }),
    });
    const got = await svc.getLaunchInfo(50);
    expect(got?.launchExe).toBe('y.exe');
  });

  it('survives a stale-schema cache file by starting fresh', async () => {
    writeFileSync(
      join(tmpDir, 'cache.json'),
      JSON.stringify({ v: 99, apps: { 1: {} } }),
    );
    const svc = new SteamAppInfoService({
      cachePath: join(tmpDir, 'cache.json'),
      fetcher: async (id) => ({
        installdir: 'Z',
        launchExe: 'z.exe',
        arch: 'x86',
      }),
    });
    const got = await svc.getLaunchInfo(1);
    expect(got?.installdir).toBe('Z');
    expect(got?.launchExe).toBe('z.exe');
    expect(got?.arch).toBe('x86');
  });

  it('readOnly skips the disk write', async () => {
    const cachePath = join(tmpDir, 'ro-cache.json');
    const svc = new SteamAppInfoService({
      cachePath,
      fetcher: async (id) => ({
        installdir: 'RO',
        launchExe: 'ro.exe',
        arch: 'x64',
      }),
      readOnly: true,
    });
    await svc.getLaunchInfo(7);
    expect(existsSync(cachePath)).toBe(false);
  });

  it('persists a fetcher-provided entry to disk and roundtrips it', async () => {
    const cachePath = join(tmpDir, 'disk-roundtrip.json');
    const svc = new SteamAppInfoService({
      cachePath,
      fetcher: async (id) => ({
        installdir: 'A',
        launchExe: 'a.exe',
        arch: 'x64',
      }),
    });
    await svc.getLaunchInfo(7);
    expect(existsSync(cachePath)).toBe(true);

    const raw = JSON.parse(readFileSync(cachePath, 'utf8'));
    expect(raw.v).toBe(1);
    expect(raw.apps['7'].launchExe).toBe('a.exe');
    expect(raw.apps['7'].arch).toBe('x64');
    expect(typeof raw.apps['7'].ts).toBe('number');
  });
});

// ── Subprocess sanity-check: confirm an existing disk cache is loaded ──

describe('SteamAppInfoService — disk round-trip without fetcher', () => {
  it('reads its own writes when re-instantiated on the same file', async () => {
    const cachePath = join(tmpDir, 'roundtrip.json');
    // Pre-populate the cache file as if a previous session had written it.
    const seed = {
      v: 1 as const,
      apps: {
        '6000': {
          installdir: 'Star Wars Republic Commando',
          launchExe: 'GameData\\System\\SWRepublicCommando.exe',
          arch: 'x86' as const,
          ts: Date.now(),
        },
      },
    };
    writeFileSync(cachePath, JSON.stringify(seed));
    const svc = new SteamAppInfoService({
      cachePath,
      fetcher: async () => {
        throw new Error('cache hit should not call fetcher');
      },
    });
    const got = await svc.getLaunchInfo(6000);
    expect(got).toEqual({
      installdir: 'Star Wars Republic Commando',
      launchExe: 'GameData\\System\\SWRepublicCommando.exe',
      arch: 'x86',
    });
  });

  it('does not expose the timestamp field in the public snapshot', async () => {
    const cachePath = join(tmpDir, 'snapshot.json');
    const svc = new SteamAppInfoService({ cachePath });
    svc.put(9, {
      installdir: 'X',
      launchExe: 'x.exe',
      arch: 'x64',
    });
    const snap = svc.snapshot();
    expect(snap[9]).toEqual({
      installdir: 'X',
      launchExe: 'x.exe',
      arch: 'x64',
    });
    expect(snap[9]).not.toHaveProperty('ts');
  });
});

// ── Timeout & reset behaviour (real-world failure modes) ────────────

describe('SteamAppInfoService — failure modes', () => {
  it('returns null when getProductInfo never resolves (timeout fires)', async () => {
    // Stub client: emits 'loggedOn' on demand, but getProductInfo's
    // callback never fires. The injected 50ms timeout must rescue the
    // caller well before vitest's 5s test timeout — the production
    // cap is 30s but tests can shrink it via opts.
    let emitLoggedOn: () => void = () => {};
    const stuckClient = {
      listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
      logOn() {
        // Defer the loggedOn event so the caller is forced to wait on
        // the connect promise — mirrors a real Steam login in flight.
        queueMicrotask(() => emitLoggedOn());
      },
      logOff() {},
      getProductInfo() {
        // Never invoke the callback. Promise.race's timeout branch wins.
      },
      on(ev: string, l: (...args: unknown[]) => void) {
        if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
        this.listeners.get(ev)!.add(l);
      },
      once(ev: string, l: (...args: unknown[]) => void) {
        this.on(ev, l);
      },
      off(ev: string, l: (...args: unknown[]) => void) {
        this.listeners.get(ev)?.delete(l);
      },
      __emit(ev: string) {
        const ls = this.listeners.get(ev);
        if (!ls) return;
        for (const l of [...ls]) l();
      },
    };
    stuckClient.logOn = function () {
      const self = this as unknown as { __emit: (e: string) => void };
      queueMicrotask(() => self.__emit('loggedOn'));
    };
    // Stash a setter we can drive from the test.
    Object.defineProperty(stuckClient, '__loggedOnSink', {
      value: (cb: () => void) => {
        emitLoggedOn = cb;
      },
      enumerable: false,
    });

    const svc = new SteamAppInfoService({
      cachePath: join(tmpDir, 'timeout-cache.json'),
      createClient: () =>
        stuckClient as unknown as SteamClientHandle,
      picsTimeoutMs: 50,
      connectTimeoutMs: 5_000,
    });
    const start = Date.now();
    const got = await svc.getLaunchInfo(6000);
    const elapsed = Date.now() - start;
    expect(got).toBeNull();
    // The 50ms PICS timeout must have fired; this should resolve
    // well under vitest's 5s test default.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('rejects a connection that never emits loggedOn (connect timeout)', async () => {
    const stuckClient = {
      listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
      logOn() {
        // Never emit loggedOn, never emit error. Sit forever.
      },
      logOff() {},
      getProductInfo() {},
      on(ev: string, l: (...args: unknown[]) => void) {
        if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
        this.listeners.get(ev)!.add(l);
      },
      once(ev: string, l: (...args: unknown[]) => void) {
        this.on(ev, l);
      },
      off(ev: string, l: (...args: unknown[]) => void) {
        this.listeners.get(ev)?.delete(l);
      },
    };
    const svc = new SteamAppInfoService({
      cachePath: join(tmpDir, 'connect-timeout-cache.json'),
      createClient: () =>
        stuckClient as unknown as SteamClientHandle,
      connectTimeoutMs: 50,
      picsTimeoutMs: 30_000,
    });
    const got = await svc.getLaunchInfo(7);
    expect(got).toBeNull();
  });
});

describe('_resetDefaultSteamAppInfoService', () => {
  it('drops the cached singleton so the next call returns a fresh instance', async () => {
    const { defaultSteamAppInfoService, _resetDefaultSteamAppInfoService } =
      await import('./steam-app-info');
    // Prime the singleton with a known-failing fetcher.
    const primed = defaultSteamAppInfoService();
    // (Indirect: there's no public setter for the fetcher, but the
    // test's value is purely the *instance identity* — we just want
    // the next call to return a NEW one after the reset.)
    _resetDefaultSteamAppInfoService();
    const fresh = defaultSteamAppInfoService();
    expect(fresh).not.toBe(primed);
    _resetDefaultSteamAppInfoService();
  });
});

// ── parseGenreIds ─────────────────────────────────────────────────────

describe('parseGenreIds', () => {
  it('extracts numeric-keyed genre ids from common.genres', () => {
    expect(
      parseGenreIds({ common: { genres: { '0': '1', '1': '23' } } })
    ).toEqual(['1', '23']);
  });

  it('accepts numeric values and dedupes', () => {
    expect(
      parseGenreIds({ common: { genres: { '0': 1, '1': '1', '2': 25 } } })
    ).toEqual(['1', '25']);
  });

  it('falls back to primary_genre when the genres block is missing', () => {
    expect(parseGenreIds({ common: { primary_genre: '3' } })).toEqual(['3']);
  });

  it('returns [] for malformed trees and non-numeric values', () => {
    expect(parseGenreIds(null)).toEqual([]);
    expect(parseGenreIds({})).toEqual([]);
    expect(parseGenreIds({ common: {} })).toEqual([]);
    expect(parseGenreIds({ common: { genres: { '0': 'Action' } } })).toEqual([]);
  });
});

// ── SteamAppInfoService.getGenreIds: bulk + cache ─────────────────────

describe('SteamAppInfoService.getGenreIds', () => {
  function makeGenreService(
    genreFetcher: (appids: number[]) => Promise<{ apps?: Record<string, { appinfo?: unknown }> }>,
    cacheName = 'genre-cache.json'
  ): SteamAppInfoService {
    return new SteamAppInfoService({
      cachePath: join(tmpDir, cacheName),
      genreFetcher,
      fetcher: async () => null,
    });
  }

  const picsResult = (apps: Record<string, string[]>) => ({
    apps: Object.fromEntries(
      Object.entries(apps).map(([appid, ids]) => [
        appid,
        {
          appinfo: {
            common: {
              genres: Object.fromEntries(ids.map((id, i) => [String(i), id])),
            },
          },
        },
      ])
    ),
  });

  it('resolves all misses in ONE bulk call and caches to disk', async () => {
    const calls: number[][] = [];
    const svc = makeGenreService(async (appids) => {
      calls.push(appids);
      return picsResult({ '10': ['1', '23'], '20': ['2'] });
    });

    const got = await svc.getGenreIds([10, 20]);
    expect(got.get(10)).toEqual(['1', '23']);
    expect(got.get(20)).toEqual(['2']);
    expect(calls).toEqual([[10, 20]]);

    // Second instance replays from disk without fetching.
    const svc2 = makeGenreService(async () => {
      throw new Error('should not be called');
    });
    const replay = await svc2.getGenreIds([10, 20]);
    expect(replay.get(10)).toEqual(['1', '23']);
    expect(calls).toEqual([[10, 20]]);
  });

  it('caches negatives — unknown appids are not re-asked', async () => {
    const calls: number[][] = [];
    const svc = makeGenreService(async (appids) => {
      calls.push(appids);
      return { apps: {} };
    });
    expect((await svc.getGenreIds([77])).get(77)).toEqual([]);
    expect((await svc.getGenreIds([77])).get(77)).toEqual([]);
    expect(calls).toEqual([[77]]);
  });

  it('only fetches the subset the cache does not cover', async () => {
    const calls: number[][] = [];
    const svc = makeGenreService(async (appids) => {
      calls.push(appids);
      return picsResult({ '1': ['1'], '2': ['2'], '3': ['3'] });
    });
    await svc.getGenreIds([1, 2]);
    await svc.getGenreIds([1, 2, 3]);
    expect(calls).toEqual([[1, 2], [3]]);
  });

  it('returns the cached subset when the bulk fetch fails', async () => {
    let fail = false;
    const svc = makeGenreService(async (appids) => {
      if (fail) throw new Error('CM down');
      return picsResult(Object.fromEntries(appids.map((a) => [String(a), ['1']])));
    });
    await svc.getGenreIds([5]);
    fail = true;
    const got = await svc.getGenreIds([5, 6]);
    expect(got.get(5)).toEqual(['1']);
    expect(got.has(6)).toBe(false);
  });

  it('ignores invalid appids', async () => {
    const calls: number[][] = [];
    const svc = makeGenreService(async (appids) => {
      calls.push(appids);
      return { apps: {} };
    });
    const got = await svc.getGenreIds([0, -5, 1.5]);
    expect(got.size).toBe(0);
    expect(calls).toEqual([]);
  });
});

// silence unused-import linter
void vi;

describe('SteamAppInfoService — paths integration', () => {
  it('falls back to paths.cache when no cachePath is given', () => {
    // We don't actually write anywhere in this test because the
    // service is in readOnly mode; the smoke we want is that the
    // constructor doesn't throw when paths.cache exists (mocked to
    // /tmp/steam-client-test) and the instance is usable.
    const svc = new SteamAppInfoService({ readOnly: true });
    expect(typeof svc.getLaunchInfo).toBe('function');
    void mkdirSync(join(tmpDir, 'noop'), { recursive: true });
  });
});
