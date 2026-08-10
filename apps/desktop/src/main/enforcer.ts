import { basename, extname } from 'node:path';
import psList from 'ps-list';
import log from 'electron-log/main.js';
import {
  closePlaySession,
  getBalance,
  openPlaySession,
  spend,
} from './ledger';
import { pushWs } from './server';
import { getFeatureFlags } from './feature-flags';

type EnforcerState = {
  appid: number;
  pid: number | null;
  sessionId: number;
  matchNames: string[];
  tickMs: number;
  searchUntil: number;
  timer: NodeJS.Timeout | null;
  /** Seconds counted while metered — one per tick, so they can't drift from
   *  the seconds actually spent. Unmetered runs read the clock instead. */
  ticks: number;
  /** Epoch ms the process we are currently watching was first seen, or 0
   *  while we are still looking for one. */
  runningSince: number;
  /** Milliseconds already banked from earlier stints — see the hand-off
   *  below. Kept in ms so the arithmetic never rounds twice. */
  bankedMs: number;
  /** Epoch ms of the last tick that found the process alive. The session is
   *  closed at this mark rather than at "now": the game died at some point
   *  in the poll interval we just slept through, and crediting that whole
   *  interval would inflate every session by up to one tick. */
  lastAliveAt: number;
  /** Meter and kill the game when the balance runs out. Off means this is a
   *  stopwatch only — see startEnforcing. */
  metered: boolean;
  /** True while a tick() coroutine is mid-flight — prevents overlap when
   *  ps-list stalls and the interval fires again. */
  ticking: boolean;
};

let current: EnforcerState | null = null;

/** A tracked process that dies before this much has been watched is treated
 *  as a launcher handing off, not as the player quitting. */
const HANDOFF_MAX_MS = 30_000;

/**
 * Process names to look for, derived from the exe we are about to spawn.
 *
 * The spawned child is not always the game: for titles patched with
 * ColdClientLoader the loader execs the real exe and exits, and UE launchers
 * do the same (Tropico6.exe → Tropico6-Win64-Shipping.exe). So we watch by
 * name as well as by pid.
 *
 * Both the bare stem and the full filename are returned — see matchesGame
 * for how each is used.
 */
export function processNamesForExe(exePath: string): string[] {
  const file = basename(exePath);
  const stem = basename(exePath, extname(exePath));
  return stem && stem !== file ? [stem, file] : [file];
}

/** Below this, a stem is too generic to trust as a prefix. "hl" would take
 *  the first process whose name merely starts with those two letters. */
const MIN_PREFIX_LEN = 4;

/**
 * Is this process the game we launched?
 *
 * Deliberately not a substring test. ps-list reports only the image name on
 * Windows (`cmd` is undefined there), so `hay.includes(needle)` matched any
 * process whose name merely CONTAINED the stem: a game shipping as
 * `Client.exe` found our own "Steam Client.exe", `Game.exe` found
 * `EdgeGameAssist.exe`. The enforcer would then track a process that never
 * exits — and in metered mode SIGKILL it when the balance ran out.
 *
 * So: exact image-name match, or the stem followed by a separator, which is
 * what the launcher → shipping-exe rename actually looks like
 * (Tropico6 → Tropico6-Win64-Shipping.exe). Prefix matching needs a stem
 * long enough to mean something.
 */
export function matchesGame(
  proc: { name?: string; cmd?: string },
  needles: string[]
): boolean {
  const candidates = new Set<string>();
  if (proc.name) candidates.add(basename(proc.name).toLowerCase());
  // On platforms that do report it, the last path segment of the command is
  // the executable — more precise than the (possibly truncated) name.
  if (proc.cmd) {
    const first = proc.cmd.trim().split(/\s+/)[0];
    if (first) candidates.add(basename(first.replace(/["']/g, '')).toLowerCase());
  }
  for (const candidate of candidates) {
    const candidateStem = candidate.replace(/\.[^.]*$/, '');
    for (const raw of needles) {
      const needle = raw.toLowerCase();
      if (candidate === needle || candidateStem === needle) return true;
      if (
        needle.length >= MIN_PREFIX_LEN &&
        candidateStem.startsWith(needle) &&
        /[-_. ]/.test(candidateStem.charAt(needle.length))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Start tracking a running game. Returns false if another app is already
 * being tracked — callers surface the mistake instead of silently dropping it.
 *
 * Two jobs live here, and they are deliberately separable:
 *
 *   - the stopwatch — open a play_sessions row, find the game's process,
 *     count the seconds it stays alive, close the row when it exits. This is
 *     what the statistics screen reads, so it runs unconditionally.
 *   - the meter — spend a second of balance per tick and kill the game when
 *     it runs out. Only when the balance feature is on.
 *
 * These used to be one thing, so turning the balance off (which is now the
 * normal state — access is granted by task, not metered by the minute) took
 * playtime tracking down with it and every game reported zero hours.
 */
export async function startEnforcing(
  appid: number,
  matchNames: string[]
): Promise<boolean> {
  if (current) {
    log.warn('[enforcer] already running for app', current.appid);
    return false;
  }
  if (matchNames.length === 0) {
    log.warn('[enforcer] no process names to match for app', appid);
    return false;
  }
  const flags = await getFeatureFlags();
  const metered = flags.balanceEnabled;
  const sessionId = openPlaySession(appid);
  current = {
    appid,
    pid: null,
    sessionId,
    matchNames,
    // Metering spends a second per tick, so it has to tick every second.
    // A stopwatch doesn't: it reads the clock, and a full process list once
    // a second for a whole evening of play is a cost with nothing to buy.
    tickMs: metered ? 1000 : 5000,
    searchUntil: Date.now() + 60_000, // 60s to find the game process
    timer: null,
    ticks: 0,
    runningSince: 0,
    bankedMs: 0,
    lastAliveAt: 0,
    metered,
    ticking: false,
  };
  log.info('[enforcer] started for app', appid, {
    matchNames,
    metered: current.metered,
  });
  current.timer = setInterval(tick, current.tickMs);
  return true;
}

/**
 * Hand the enforcer the pid we just spawned, skipping the name search.
 *
 * Only correct when the spawned process IS the game — a ColdClientLoader or
 * a thin launcher exits immediately and would end the session a second later.
 * Callers pass the pid only on the direct-spawn path.
 */
export function adoptSpawnedPid(appid: number, pid: number | undefined): void {
  if (!current || current.appid !== appid || current.pid !== null) return;
  if (typeof pid !== 'number' || pid <= 0) return;
  current.pid = pid;
  current.runningSince = Date.now();
  current.lastAliveAt = current.runningSince;
  log.info('[enforcer] adopted spawned pid', pid);
  pushWs({ type: 'game', status: 'running', appid });
}

async function tick(): Promise<void> {
  if (!current) return;
  // Re-entrancy guard: if ps-list stalls longer than tickMs, overlapping
  // ticks would double-spend and double-kill. Skip until previous finishes.
  if (current.ticking) return;
  current.ticking = true;
  try {
    await tickBody();
  } finally {
    if (current) current.ticking = false;
  }
}

async function tickBody(): Promise<void> {
  if (!current) return;

  // Phase 1: find PID
  if (current.pid === null) {
    try {
      const processes = await psList();
      const match = processes.find(
        // Never adopt ourselves: a game whose exe is named like the launcher
        // would otherwise be "found" instantly, and metered mode would go on
        // to kill the process this code is running in.
        (p) => p.pid !== process.pid && matchesGame(p, current!.matchNames)
      );
      if (match) {
        current.pid = match.pid;
        current.runningSince = Date.now();
        current.lastAliveAt = current.runningSince;
        log.info('[enforcer] found pid', match.pid, 'name', match.name);
        pushWs({ type: 'game', status: 'running', appid: current.appid });
      } else if (Date.now() > current.searchUntil) {
        log.warn('[enforcer] game not started within timeout, giving up');
        stopEnforcing(current.bankedMs > 0 ? 'user_quit' : 'not_started');
      }
      return;
    } catch (err) {
      log.error('[enforcer] ps-list error:', (err as Error).message);
      return;
    }
  }

  // Phase 2: count the seconds the game is alive, and meter them if the
  // balance feature is on.
  try {
    const processes = await psList();
    const alive = processes.some((p) => p.pid === current!.pid);
    if (!alive) {
      // A process that dies almost immediately is usually a hand-off, not a
      // quit: ColdClientLoader and thin launchers (Tropico6.exe spawning
      // Tropico6-Win64-Shipping.exe) exec the real game and exit within a
      // second or two. Bank what we watched and go back to looking — ending
      // the session here would credit two seconds to an evening of play.
      //
      // Bounded twice over, so a real quit is never mistaken for a hand-off:
      // only inside the search window, and only while the whole session so
      // far is shorter than any plausible play session. Someone who really
      // does quit after twenty seconds still gets those seconds — the row
      // closes at the search deadline instead of at the click.
      const stint = Math.max(0, current.lastAliveAt - current.runningSince);
      if (
        Date.now() < current.searchUntil &&
        current.bankedMs + stint < HANDOFF_MAX_MS
      ) {
        current.bankedMs += stint;
        log.info('[enforcer] watched process exited early, resuming search');
        current.pid = null;
        current.runningSince = 0;
        current.lastAliveAt = 0;
        return;
      }
      log.info('[enforcer] game exited on its own');
      stopEnforcing('user_quit');
      return;
    }

    current.lastAliveAt = Date.now();

    if (!current.metered) return;

    current.ticks++;

    // TODO: spend is local-only. The backend has no session/usage/tick
    // endpoint as of 2026-05-19, so gameplay seconds never reach the server.
    // Plug a server call in here once the endpoint lands.
    const balance = spend(1, `play:${current.appid}`);
    // ledger.onBalanceChange handles broadcasting to WS + renderer IPC.

    if (balance <= 0) {
      log.warn('[enforcer] balance depleted, killing pid', current.pid);
      killGame(current.pid);
      stopEnforcing('balance_depleted');
    }
  } catch (err) {
    log.error('[enforcer] tick error:', (err as Error).message);
  }
}

function killGame(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    log.warn('[enforcer] SIGTERM failed:', (err as Error).message);
  }
  setTimeout(() => {
    try {
      process.kill(pid, 0); // check if still alive
      process.kill(pid, 'SIGKILL');
      log.warn('[enforcer] SIGKILL sent');
    } catch {
      // already dead
    }
  }, 5000);
}

/**
 * Seconds to credit this session. Metered runs report the seconds they
 * actually spent; unmetered runs measure from the moment the process was
 * found to the last tick that saw it alive. A session that never found its
 * process reports zero either way.
 */
function elapsedSeconds(state: EnforcerState): number {
  if (state.metered) return state.ticks;
  const stint =
    state.runningSince === 0
      ? 0
      : Math.max(0, state.lastAliveAt - state.runningSince);
  return Math.round((state.bankedMs + stint) / 1000);
}

export function stopEnforcing(reason: string): void {
  if (!current) return;
  const { sessionId, appid, timer } = current;
  if (timer) clearInterval(timer);
  const elapsed = elapsedSeconds(current);
  closePlaySession(sessionId, elapsed, reason);
  pushWs({ type: 'game', status: 'stopped', appid, reason });
  log.info('[enforcer] stopped, reason=', reason, 'elapsed=', elapsed);
  current = null;
}

export function isEnforcing(): boolean {
  return current !== null;
}

export function getEnforcingAppid(): number | null {
  return current?.appid ?? null;
}

export function getCurrentBalance(): number {
  return getBalance();
}
