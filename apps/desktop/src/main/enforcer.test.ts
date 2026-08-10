/**
 * The enforcer does two jobs — a stopwatch that feeds the statistics screen
 * and a meter that spends balance — and they used to be one. Turning the
 * balance off (the normal state now that access is granted by task rather
 * than metered by the minute) skipped the whole routine, so no play session
 * was ever opened and every game reported zero hours played.
 *
 * These tests pin the two apart.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const psListMock = vi.hoisted(() => vi.fn());
const ledgerMock = vi.hoisted(() => ({
  openPlaySession: vi.fn(() => 1),
  closePlaySession: vi.fn(),
  spend: vi.fn(() => 100),
  getBalance: vi.fn(() => 100),
}));
const flagsMock = vi.hoisted(() => ({ getFeatureFlags: vi.fn() }));

vi.mock('ps-list', () => ({ default: psListMock }));
vi.mock('./ledger', () => ledgerMock);
vi.mock('./server', () => ({ pushWs: vi.fn() }));
vi.mock('./feature-flags', () => flagsMock);
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  adoptSpawnedPid,
  isEnforcing,
  matchesGame,
  processNamesForExe,
  startEnforcing,
  stopEnforcing,
} from './enforcer';

/** Let the interval fire `n` times, awaiting the async tick body each time. */
async function runTicks(n: number, msPerTick: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(msPerTick);
  }
}

describe('processNamesForExe', () => {
  it('returns the stem and the filename', () => {
    expect(processNamesForExe('D:\\Games\\70\\hl.exe')).toEqual(['hl', 'hl.exe']);
  });

  it('collapses to one entry when there is no extension', () => {
    expect(processNamesForExe('/opt/games/hl')).toEqual(['hl']);
  });

  it('is not the hardcoded test-game list it replaced', () => {
    expect(processNamesForExe('D:\\Games\\70\\hl.exe')).not.toContain('StardewValley');
  });
});

describe('matchesGame', () => {
  it('matches the exact image name', () => {
    expect(matchesGame({ name: 'hl.exe' }, ['hl', 'hl.exe'])).toBe(true);
    expect(matchesGame({ name: 'HL.EXE' }, ['hl', 'hl.exe'])).toBe(true);
  });

  it('matches a shipping exe renamed from the launcher', () => {
    expect(
      matchesGame({ name: 'Tropico6-Win64-Shipping.exe' }, [
        'Tropico6',
        'Tropico6.exe',
      ])
    ).toBe(true);
  });

  it('does not take a process that merely contains the name', () => {
    // The bug this replaced: a game shipping as Client.exe latched onto the
    // launcher's own process, and metered mode would go on to kill it.
    expect(matchesGame({ name: 'Steam Client.exe' }, ['client', 'client.exe'])).toBe(
      false
    );
    expect(matchesGame({ name: 'EdgeGameAssist.exe' }, ['game', 'game.exe'])).toBe(
      false
    );
    expect(matchesGame({ name: 'backgroundTaskHost.exe' }, ['ac', 'ac.exe'])).toBe(
      false
    );
  });

  it('will not prefix-match on a stem too short to mean anything', () => {
    expect(matchesGame({ name: 'hl-something.exe' }, ['hl', 'hl.exe'])).toBe(false);
  });

  it('uses the executable from the command when the platform reports one', () => {
    expect(
      matchesGame({ name: 'wine-preloader', cmd: '/opt/games/70/hl.exe -novid' }, [
        'hl',
        'hl.exe',
      ])
    ).toBe(true);
  });
});

describe('enforcer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-08T12:00:00Z'));
    psListMock.mockReset();
    ledgerMock.openPlaySession.mockClear().mockReturnValue(7);
    ledgerMock.closePlaySession.mockClear();
    ledgerMock.spend.mockClear().mockReturnValue(100);
    flagsMock.getFeatureFlags.mockReset();
  });

  afterEach(() => {
    if (isEnforcing()) stopEnforcing('test_cleanup');
    vi.useRealTimers();
  });

  it('opens a play session even when the balance feature is off', async () => {
    flagsMock.getFeatureFlags.mockResolvedValue({ balanceEnabled: false });
    psListMock.mockResolvedValue([]);

    const started = await startEnforcing(70, ['hl', 'hl.exe']);

    expect(started).toBe(true);
    expect(ledgerMock.openPlaySession).toHaveBeenCalledWith(70);
  });

  it('records the seconds a game was alive with the balance off', async () => {
    flagsMock.getFeatureFlags.mockResolvedValue({ balanceEnabled: false });
    // Alive for the first four polls, gone on the fifth.
    psListMock
      .mockResolvedValueOnce([{ pid: 4242, name: 'hl.exe', cmd: 'hl.exe' }])
      .mockResolvedValueOnce([{ pid: 4242, name: 'hl.exe', cmd: 'hl.exe' }])
      .mockResolvedValueOnce([{ pid: 4242, name: 'hl.exe', cmd: 'hl.exe' }])
      .mockResolvedValueOnce([{ pid: 4242, name: 'hl.exe', cmd: 'hl.exe' }])
      .mockResolvedValue([]);

    await startEnforcing(70, ['hl', 'hl.exe']);
    // Unmetered polls every 5s: tick 1 finds the pid, ticks 2-4 see it alive,
    // tick 5 finds it gone. Fifteen seconds is inside the hand-off window, so
    // the row stays open until the search deadline rather than closing on the
    // spot — the seconds are the same either way.
    await runTicks(14, 5000);

    expect(ledgerMock.closePlaySession).toHaveBeenCalledTimes(1);
    const [sessionId, seconds, reason] = ledgerMock.closePlaySession.mock.calls[0]!;
    expect(sessionId).toBe(7);
    expect(reason).toBe('user_quit');
    // Found at t=5s, last seen alive at t=20s. The interval it died in is not
    // credited, so this is 15 — not the 20 a "now minus start" would give.
    expect(seconds).toBe(15);
  });

  it('never spends balance when the feature is off', async () => {
    flagsMock.getFeatureFlags.mockResolvedValue({ balanceEnabled: false });
    psListMock.mockResolvedValue([{ pid: 4242, name: 'hl.exe', cmd: 'hl.exe' }]);

    await startEnforcing(70, ['hl', 'hl.exe']);
    await runTicks(4, 5000);

    expect(ledgerMock.spend).not.toHaveBeenCalled();
  });

  it('spends one second per tick when the feature is on', async () => {
    flagsMock.getFeatureFlags.mockResolvedValue({ balanceEnabled: true });
    psListMock.mockResolvedValue([{ pid: 4242, name: 'hl.exe', cmd: 'hl.exe' }]);

    await startEnforcing(70, ['hl', 'hl.exe']);
    // Metered polls every second: tick 1 finds the pid, ticks 2-4 spend.
    await runTicks(4, 1000);

    expect(ledgerMock.spend).toHaveBeenCalledTimes(3);
    stopEnforcing('test');
    expect(ledgerMock.closePlaySession.mock.calls[0]![1]).toBe(3);
  });

  it('gives up when the process never appears', async () => {
    flagsMock.getFeatureFlags.mockResolvedValue({ balanceEnabled: false });
    psListMock.mockResolvedValue([{ pid: 1, name: 'explorer.exe', cmd: '' }]);

    await startEnforcing(70, ['hl', 'hl.exe']);
    await runTicks(14, 5000); // past the 60s search window

    expect(ledgerMock.closePlaySession).toHaveBeenCalledWith(
      7,
      0,
      'not_started'
    );
    expect(isEnforcing()).toBe(false);
  });

  it('adopts a spawned pid instead of searching for it', async () => {
    flagsMock.getFeatureFlags.mockResolvedValue({ balanceEnabled: false });
    psListMock.mockResolvedValue([{ pid: 9001, name: 'hl.exe', cmd: 'hl.exe' }]);

    await startEnforcing(70, ['hl', 'hl.exe']);
    adoptSpawnedPid(70, 9001);
    await runTicks(2, 5000);
    stopEnforcing('test');

    // Two ticks after adoption at t=0 → last seen alive at t=10s.
    expect(ledgerMock.closePlaySession.mock.calls[0]![1]).toBe(10);
  });

  it('ignores an adopt call for a different game', async () => {
    flagsMock.getFeatureFlags.mockResolvedValue({ balanceEnabled: false });
    psListMock.mockResolvedValue([]);

    await startEnforcing(70, ['hl', 'hl.exe']);
    adoptSpawnedPid(550, 9001);
    // Time has to pass, or a wrongly adopted pid would credit zero seconds
    // too and this would pass for the wrong reason.
    await runTicks(3, 5000);
    stopEnforcing('test');

    // Never found its own process, so nothing to credit.
    expect(ledgerMock.closePlaySession.mock.calls[0]![1]).toBe(0);
  });

  it('hands off from a launcher that exits to the game it spawned', async () => {
    flagsMock.getFeatureFlags.mockResolvedValue({ balanceEnabled: false });
    const launcher = { pid: 111, name: 'Tropico6.exe', cmd: 'Tropico6.exe' };
    const game = {
      pid: 222,
      name: 'Tropico6-Win64-Shipping.exe',
      cmd: 'Tropico6-Win64-Shipping.exe',
    };
    psListMock
      .mockResolvedValueOnce([launcher]) // t=5s  found the launcher
      .mockResolvedValueOnce([launcher]) // t=10s still alive
      .mockResolvedValueOnce([game]) //     t=15s launcher gone, game up
      .mockResolvedValueOnce([game]) //     t=20s found the game
      .mockResolvedValueOnce([game]) //     t=25s alive
      .mockResolvedValue([]); //            t=30s gone

    await startEnforcing(492720, ['Tropico6', 'Tropico6.exe']);
    await runTicks(13, 5000); // both stints are short, so it closes at the deadline

    expect(ledgerMock.closePlaySession).toHaveBeenCalledTimes(1);
    const [, seconds, reason] = ledgerMock.closePlaySession.mock.calls[0]!;
    expect(reason).toBe('user_quit');
    // 5s banked from the launcher stint (found t=5s, last alive t=10s) plus
    // 5s from the game (found t=20s, last alive t=25s). Without the hand-off
    // this session would have closed at 5 seconds.
    expect(seconds).toBe(10);
  });

  it('does not end the session when an adopted launcher pid exits at once', async () => {
    flagsMock.getFeatureFlags.mockResolvedValue({ balanceEnabled: false });
    psListMock
      .mockResolvedValueOnce([]) //                       t=5s  launcher gone
      .mockResolvedValue([{ pid: 222, name: 'hl.exe', cmd: 'hl.exe' }]);

    await startEnforcing(70, ['hl', 'hl.exe']);
    adoptSpawnedPid(70, 111);
    await runTicks(3, 5000);

    expect(ledgerMock.closePlaySession).not.toHaveBeenCalled();
    expect(isEnforcing()).toBe(true);
  });

  it('stops for real once the search window has passed', async () => {
    flagsMock.getFeatureFlags.mockResolvedValue({ balanceEnabled: false });
    psListMock.mockResolvedValue([{ pid: 4242, name: 'hl.exe', cmd: 'hl.exe' }]);

    await startEnforcing(70, ['hl', 'hl.exe']);
    await runTicks(20, 5000); // well past both the hand-off and search windows
    psListMock.mockResolvedValue([]);
    await runTicks(1, 5000);

    expect(ledgerMock.closePlaySession).toHaveBeenCalledTimes(1);
    const [, seconds, reason] = ledgerMock.closePlaySession.mock.calls[0]!;
    expect(reason).toBe('user_quit');
    // Found at t=5s, last alive at t=100s: a real quit, closed on the spot.
    expect(seconds).toBe(95);
  });

  it('refuses to start a second game', async () => {
    flagsMock.getFeatureFlags.mockResolvedValue({ balanceEnabled: false });
    psListMock.mockResolvedValue([]);

    await startEnforcing(70, ['hl', 'hl.exe']);
    const second = await startEnforcing(550, ['left4dead2.exe']);

    expect(second).toBe(false);
    expect(ledgerMock.openPlaySession).toHaveBeenCalledTimes(1);
  });

  it('refuses to start with nothing to match on', async () => {
    flagsMock.getFeatureFlags.mockResolvedValue({ balanceEnabled: false });

    expect(await startEnforcing(70, [])).toBe(false);
    expect(ledgerMock.openPlaySession).not.toHaveBeenCalled();
  });
});
