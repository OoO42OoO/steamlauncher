import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  SteamAppDetailsDataSchema,
  currentGamePlatform,
  supportedPlatforms,
  clearCache,
  configureStoreDiskCache,
  peekAppDetails,
} from './steam-store';

describe('steam-store schema', () => {
  beforeEach(() => clearCache());

  it('parses platforms when present', () => {
    const parsed = SteamAppDetailsDataSchema.parse({
      name: 'X',
      steam_appid: 1,
      platforms: { windows: true, mac: false, linux: true },
    });
    expect(parsed.platforms).toEqual({ windows: true, mac: false, linux: true });
  });

  it('treats platforms as optional', () => {
    const parsed = SteamAppDetailsDataSchema.parse({ name: 'X', steam_appid: 1 });
    expect(parsed.platforms).toBeUndefined();
  });

  it('accepts the empty-array requirements form Steam emits for old titles', () => {
    // e.g. appid 6000: linux_requirements comes back as [] instead of {}.
    const parsed = SteamAppDetailsDataSchema.parse({
      name: 'X',
      steam_appid: 6000,
      pc_requirements: { minimum: '<ul></ul>' },
      linux_requirements: [],
      mac_requirements: [],
    });
    expect(parsed.linux_requirements).toEqual([]);
  });
});

describe('disk cache', () => {
  let dir: string;

  beforeEach(() => {
    clearCache();
    dir = mkdtempSync(join(tmpdir(), 'steam-store-test-'));
  });
  afterEach(() => {
    clearCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('peek hydrates unexpired entries from the configured file', () => {
    const file = join(dir, 'cache.json');
    const data = { name: 'Cached Game', steam_appid: 42 };
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        entries: {
          '42:english': { data, expiresAt: Date.now() + 60_000 },
          '43:english': { data: { name: 'Stale', steam_appid: 43 }, expiresAt: 1 },
        },
      })
    );
    configureStoreDiskCache(file);
    expect(peekAppDetails(42, 'en')?.name).toBe('Cached Game');
    expect(peekAppDetails(43, 'en')).toBeNull();
  });

  it('peek returns null on missing or corrupt cache file', () => {
    configureStoreDiskCache(join(dir, 'nope.json'));
    expect(peekAppDetails(1, 'en')).toBeNull();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    configureStoreDiskCache(bad);
    expect(peekAppDetails(1, 'en')).toBeNull();
  });

  it('peek never hits the network for unknown appids', () => {
    // No fetch mock installed — a network attempt would throw/hang.
    expect(peekAppDetails(999999, 'en')).toBeNull();
  });
});

describe('currentGamePlatform', () => {
  it('maps common Node platforms to Steam identifiers', () => {
    expect(currentGamePlatform('win32')).toBe('windows');
    expect(currentGamePlatform('darwin')).toBe('mac');
    expect(currentGamePlatform('linux')).toBe('linux');
    expect(currentGamePlatform('aix')).toBeNull();
  });
});

describe('supportedPlatforms', () => {
  it('returns supported flags as a list', () => {
    expect(
      supportedPlatforms({
        name: 'X',
        steam_appid: 1,
        platforms: { windows: true, mac: false, linux: true },
      })
    ).toEqual(['windows', 'linux']);
  });

  it('returns empty when platforms missing', () => {
    expect(supportedPlatforms({ name: 'X', steam_appid: 1 })).toEqual([]);
    expect(supportedPlatforms(null)).toEqual([]);
  });
});
