/**
 * Pure tests for resolveTargetOs(): the platform-aware -os flag chooser
 * that replaces the old '-os linux' hardcode in downloader.ts.
 *
 * Same module-mocking dance as downloader-email-guard.test.ts — importing
 * downloader.ts pulls in `paths`, `settings`, `vault`, `ledger`, and
 * `electron`, all of which would explode under bare-Node Vitest.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    setName: () => {},
    getPath: () => '/tmp/steam-client-test',
    requestSingleInstanceLock: () => true,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));
vi.mock('electron-log/main.js', () => ({
  default: {
    info: () => {},
    warn: () => {},
    error: () => {},
    transports: { file: { resolvePathFn: null } },
  },
}));
vi.mock('./paths', () => ({
  paths: { cache: '/tmp/cache', authToken: '/tmp/api-token' },
  lockFileMode: () => {},
  resolveDepotDownloaderPath: () => '/usr/bin/true',
}));
vi.mock('./settings', () => ({ getInstallRoot: () => '/tmp/installs' }));
vi.mock('./ledger', () => ({ upsertInstall: () => {} }));
vi.mock('./vault', () => ({ withAccount: async () => {} }));

import { resolveTargetOs } from './downloader';

describe('resolveTargetOs', () => {
  it('windows host + windows-only game → windows', () => {
    expect(resolveTargetOs('windows', ['windows'])).toBe('windows');
  });

  it('linux host + windows-only game → windows (Proton fallback)', () => {
    expect(resolveTargetOs('linux', ['windows'])).toBe('windows');
  });

  it('linux host + linux+windows game → linux (host wins)', () => {
    expect(resolveTargetOs('linux', ['linux', 'windows'])).toBe('linux');
  });

  it('mac host + linux-only game → linux', () => {
    expect(resolveTargetOs('mac', ['linux'])).toBe('linux');
  });

  it('mac host + mac+linux+windows game → mac (host wins)', () => {
    expect(resolveTargetOs('mac', ['mac', 'linux', 'windows'])).toBe('mac');
  });

  it('windows host + linux-only game → linux', () => {
    expect(resolveTargetOs('windows', ['linux'])).toBe('linux');
  });

  it('linux host + mac+windows game → windows (Proton preferred over mac)', () => {
    expect(resolveTargetOs('linux', ['mac', 'windows'])).toBe('windows');
  });

  it('empty supported list → null (caller must fail-fast)', () => {
    expect(resolveTargetOs('linux', [])).toBeNull();
    expect(resolveTargetOs('windows', [])).toBeNull();
    expect(resolveTargetOs(null, [])).toBeNull();
  });

  it('null host with supported list → first available (windows preferred)', () => {
    expect(resolveTargetOs(null, ['linux', 'windows'])).toBe('windows');
    expect(resolveTargetOs(null, ['mac', 'linux'])).toBe('linux');
    expect(resolveTargetOs(null, ['mac'])).toBe('mac');
  });
});
