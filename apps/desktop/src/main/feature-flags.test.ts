import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each case writes its own settings.json into a fresh tmp dir and points
// `paths.settings` at it via vi.mock. The cache is reset between cases so
// the resolver runs fresh every time.
let settingsPath = '';
let tmpDir = '';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', setName: () => {}, isPackaged: false },
}));
vi.mock('./paths', () => ({
  paths: {
    get settings() {
      return settingsPath;
    },
  },
  lockFileMode: () => {},
  ensurePaths: () => {},
}));

import {
  _resetFeatureFlagsCache,
  configureFeatureFlags,
  getFeatureFlags,
  refreshFeatureFlags,
} from './feature-flags';

type StubApi = {
  getBalanceEnabled: ReturnType<typeof vi.fn>;
};

function stubApi(impl: () => Promise<boolean>): StubApi {
  return { getBalanceEnabled: vi.fn(impl) };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'feature-flags-test-'));
  settingsPath = join(tmpDir, 'settings.json');
  delete process.env.STEAM_CLIENT_BALANCE_ENABLED;
  _resetFeatureFlagsCache();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.STEAM_CLIENT_BALANCE_ENABLED;
});

describe('getFeatureFlags', () => {
  it('defaults to balanceEnabled=true when env is unset and settings.json absent', async () => {
    const flags = await getFeatureFlags();
    expect(flags.balanceEnabled).toBe(true);
  });

  it("returns balanceEnabled=false when STEAM_CLIENT_BALANCE_ENABLED='false'", async () => {
    process.env.STEAM_CLIENT_BALANCE_ENABLED = 'false';
    const flags = await getFeatureFlags();
    expect(flags.balanceEnabled).toBe(false);
  });

  it('returns balanceEnabled=false when settings.json has balanceEnabled:false', async () => {
    writeFileSync(settingsPath, JSON.stringify({ balanceEnabled: false }));
    const flags = await getFeatureFlags();
    expect(flags.balanceEnabled).toBe(false);
  });

  it('uses API value when API returns true', async () => {
    // Settings says false; API says true — API wins.
    writeFileSync(settingsPath, JSON.stringify({ balanceEnabled: false }));
    const api = stubApi(async () => true);
    configureFeatureFlags(api as never);
    const flags = await refreshFeatureFlags();
    expect(flags.balanceEnabled).toBe(true);
    expect(api.getBalanceEnabled).toHaveBeenCalledOnce();
  });

  it('uses API value when API returns false (flag off)', async () => {
    // Default would be true and env unset; API explicitly disables.
    const api = stubApi(async () => false);
    configureFeatureFlags(api as never);
    const flags = await refreshFeatureFlags();
    expect(flags.balanceEnabled).toBe(false);
  });

  it('falls back to env when API throws', async () => {
    process.env.STEAM_CLIENT_BALANCE_ENABLED = 'false';
    const api = stubApi(async () => {
      throw new Error('network down');
    });
    configureFeatureFlags(api as never);
    const flags = await refreshFeatureFlags();
    expect(flags.balanceEnabled).toBe(false);
    expect(api.getBalanceEnabled).toHaveBeenCalledOnce();
  });
});
