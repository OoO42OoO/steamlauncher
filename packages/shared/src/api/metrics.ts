import { z } from 'zod';

// ── games ──────────────────────────────────────────────────────────────

export const GameMetricReadSchema = z.object({
  user_id: z.string().min(1),
  appid: z.number().int().min(1),
  game_name: z.string(),
  play_time_minutes: z.number().int().min(0),
});
export type GameMetricRead = z.infer<typeof GameMetricReadSchema>;

/**
 * POST /metrics/games body — upsert totals by (user_id, account_id, appid).
 * `account_id` is required as of the 2026-04 API update: it lets the server
 * treat recent metric updates as an implicit "still playing on this account"
 * heartbeat and hold the pool lock until a cooldown window elapses.
 */
export const GameMetricUpsertSchema = z.object({
  user_id: z.string().min(1).max(24),
  account_id: z.string().min(1).max(24),
  appid: z.number().int().min(1),
  game_name: z.string().min(1).max(255),
  play_time_minutes: z.number().int().min(0),
});
export type GameMetricUpsert = z.infer<typeof GameMetricUpsertSchema>;

export const GameMetricListQuerySchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  user_id: z.string().optional(),
  appid: z.number().int().min(1).optional(),
});
export type GameMetricListQuery = z.infer<typeof GameMetricListQuerySchema>;

// ── sites ──────────────────────────────────────────────────────────────

export const SiteMetricReadSchema = z.object({
  user_id: z.string().min(1),
  domain: z.string(),
  time_spent_minutes: z.number().int().min(0),
});
export type SiteMetricRead = z.infer<typeof SiteMetricReadSchema>;

/** POST /metrics/sites body — upsert totals by (user_id, domain). */
export const SiteMetricUpsertSchema = z.object({
  user_id: z.string().min(1).max(24),
  domain: z.string().min(1).max(255),
  time_spent_minutes: z.number().int().min(0),
});
export type SiteMetricUpsert = z.infer<typeof SiteMetricUpsertSchema>;

export const SiteMetricListQuerySchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  user_id: z.string().optional(),
  domain: z.string().optional(),
});
export type SiteMetricListQuery = z.infer<typeof SiteMetricListQuerySchema>;
