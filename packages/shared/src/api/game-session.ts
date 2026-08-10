import { z } from 'zod';

/**
 * GET /game-sessions/me — the caller's current game session.
 *
 * A game session is the server-side entitlement to actually PLAY: it is
 * granted (POST /game-sessions) after the user completes tasks in the
 * Telegram bot and is handed a fresh auth code. It expires on its own after a
 * few hours, which is why the launcher re-checks before every install/launch
 * instead of caching a verdict forever.
 *
 * Without an active session the API still serves profile, tasks, balance and
 * the game list, but the endpoints an install/launch actually needs — pool
 * account credentials, Steam Guard codes, heartbeat — answer
 * `403 Active game session is required`.
 *
 * `issued_at` / `expires_at` are null when the user has never held a session.
 * `remaining_seconds` is 0 in that case (and whenever a session has lapsed),
 * so it is the single field safe to drive a countdown from.
 */
export const GameSessionReadSchema = z.object({
  user_id: z.string().min(1),
  is_active: z.boolean(),
  issued_at: z.string().nullish(),
  expires_at: z.string().nullish(),
  remaining_seconds: z.number().int(),
});
export type GameSessionRead = z.infer<typeof GameSessionReadSchema>;
