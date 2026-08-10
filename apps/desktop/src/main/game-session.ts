/**
 * Game-session gate.
 *
 * Playing is entitled by a server-side *game session* that lapses after a few
 * hours. It is granted when the user completes a task in the Telegram bot —
 * the bot opens access directly, there is no code to bring back. Profile,
 * tasks and the game list keep working without one, but the endpoints an
 * install/launch depends on (pool credentials, Steam Guard codes, heartbeat)
 * answer `403 Active game session is required`.
 *
 * So we check BEFORE starting an install or a launch, rather than letting the
 * user watch a download die on a 403 halfway through.
 *
 * No caching, by design. Every install and every launch asks the server: the
 * question is "may this user play right now", the answer can change between
 * two clicks (the session lapses on its own clock, and the bot can grant one
 * at any moment), and one small request per click is not worth the class of
 * bug a cache introduces.
 *
 * Failure policy: closed. If we cannot get an answer — no network, a 5xx, a
 * timeout — the verdict is `'unreachable'` and the caller refuses to start.
 * This used to fail open on the reasoning that our own API being down should
 * not stop someone playing; that reasoning does not survive contact with what
 * the gate is for, since "the server is unreachable" is exactly the state an
 * unentitled client would like to be in.
 *
 * Deps are injected so tests can drive the clock and the fetcher without
 * bringing up the full main process — same pattern as install-remove.ts.
 */
import log from 'electron-log/main.js';
import type { GameSessionRead } from '@steam-client/shared/api';
import { ApiError } from './api/client';

export type GameSessionVerdict = 'ok' | 'required' | 'unreachable';

export interface GameSessionGateDeps {
  fetchSession: () => Promise<GameSessionRead>;
}

/**
 * Resolve whether the user may install/launch right now.
 *
 *   - `'ok'`          — the server confirms a live session.
 *   - `'required'`    — the server says there is none; send them to the bot.
 *   - `'unreachable'` — we could not ask; refuse and say so.
 */
export async function checkGameSession(
  deps: GameSessionGateDeps
): Promise<GameSessionVerdict> {
  let session: GameSessionRead;
  try {
    session = await deps.fetchSession();
  } catch (err) {
    // An outright 403 on this endpoint would be unusual (it is not gated),
    // but honour it if the server ever starts doing that: that is an answer,
    // not a failure to get one.
    if (err instanceof ApiError && err.code === 'game_session_required') {
      return 'required';
    }
    log.warn('[game-session] check failed', (err as Error).message);
    return 'unreachable';
  }

  if (!session.is_active) {
    log.info('[game-session] no active session — prompting for a task');
    return 'required';
  }
  return 'ok';
}
