import { describe, expect, it, vi } from 'vitest';
import { uninstallGame, type UninstallDeps } from './install-remove';

function makeDeps(overrides: Partial<UninstallDeps> = {}): UninstallDeps {
  return {
    getInstall: vi.fn(() => ({ path: '/games/413150' })),
    removeInstall: vi.fn(),
    getEnforcingAppid: vi.fn(() => null),
    installPathFor: vi.fn((appid: number) => `/games/${appid}`),
    pathExists: vi.fn(() => true),
    fsRm: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('install-remove.uninstallGame', () => {
  it('rejects a non-positive appid before touching anything', async () => {
    const deps = makeDeps();
    const res = await uninstallGame(0, deps);
    expect(res).toEqual({ success: false, error: 'bad_appid' });
    expect(deps.fsRm).not.toHaveBeenCalled();
    expect(deps.removeInstall).not.toHaveBeenCalled();
  });

  it('refuses when the enforcer reports the same appid as currently running', async () => {
    const deps = makeDeps({ getEnforcingAppid: () => 413150 });
    const res = await uninstallGame(413150, deps);
    expect(res).toEqual({ success: false, error: 'game_running' });
    expect(deps.fsRm).not.toHaveBeenCalled();
    expect(deps.removeInstall).not.toHaveBeenCalled();
  });

  it('allows uninstall when a DIFFERENT game is the one running', async () => {
    const deps = makeDeps({ getEnforcingAppid: () => 72850 });
    const res = await uninstallGame(413150, deps);
    expect(res).toEqual({ success: true });
    expect(deps.fsRm).toHaveBeenCalledTimes(1);
    expect(deps.removeInstall).toHaveBeenCalledWith(413150);
  });

  it('rms the ledger-recorded path with recursive+force, then deletes the row', async () => {
    const deps = makeDeps({
      getInstall: vi.fn(() => ({ path: '/custom/path/413150' })),
    });
    const res = await uninstallGame(413150, deps);
    expect(res).toEqual({ success: true });
    expect(deps.fsRm).toHaveBeenCalledWith('/custom/path/413150', {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 500,
    });
    expect(deps.removeInstall).toHaveBeenCalledWith(413150);
  });

  it('falls back to installPathFor when the ledger has no recorded path', async () => {
    const deps = makeDeps({
      getInstall: vi.fn(() => ({ path: null })),
      installPathFor: vi.fn(() => '/default/root/413150'),
    });
    const res = await uninstallGame(413150, deps);
    expect(res).toEqual({ success: true });
    expect(deps.fsRm).toHaveBeenCalledWith('/default/root/413150', {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 500,
    });
  });

  it('skips fs.rm when the install directory does not exist on disk, but still drops the ledger row', async () => {
    // Mirrors the case where the user manually deleted the folder: the
    // ledger row is the only remnant, so we still want it cleaned up.
    const deps = makeDeps({ pathExists: vi.fn(() => false) });
    const res = await uninstallGame(413150, deps);
    expect(res).toEqual({ success: true });
    expect(deps.fsRm).not.toHaveBeenCalled();
    expect(deps.removeInstall).toHaveBeenCalledWith(413150);
  });

  it('returns a graceful error when fs.rm rejects (EBUSY / EPERM)', async () => {
    // Windows scenario: a stale handle on a file in the install dir
    // (antivirus, Explorer preview) keeps rm from completing. We want a
    // structured error back to the renderer, not a thrown exception.
    const deps = makeDeps({
      fsRm: vi.fn(async () => {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), {
          code: 'EBUSY',
        });
      }),
    });
    const res = await uninstallGame(413150, deps);
    expect(res).toEqual({
      success: false,
      error: 'rm_failed:EBUSY',
    });
    // Ledger row stays — re-trying after the user closes the offending
    // app must still find the install record.
    expect(deps.removeInstall).not.toHaveBeenCalled();
  });

  it('bounds fs.rm with maxRetries+retryDelay so a stuck handle cannot freeze the renderer', async () => {
    // Regression test: without maxRetries/retryDelay Node's Windows fs.rm
    // retries EBUSY aggressively and the IPC handler hangs the renderer
    // long enough for the OS to mark the window as unresponsive (AppHang).
    // We pin the option names so future "simplifications" don't quietly
    // drop them.
    const deps = makeDeps();
    await uninstallGame(413150, deps);
    const opts = (deps.fsRm as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as Record<string, unknown>;
    expect(opts.maxRetries).toBe(3);
    expect(opts.retryDelay).toBe(500);
  });
});
