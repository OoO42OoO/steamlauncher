import { z } from 'zod';
import { UserReadSchema } from './user';

/**
 * POST /auth-codes/{code}/redeem response body.
 *
 * 2026-04-22: backend made the endpoint public (security:[]) and added
 * the Bearer to the response body directly.
 *
 * 2026-07: the token became PERMANENT — the backend dropped
 * `access_token_expires_at` from the response and added `redeemed_at`. Both
 * are `nullish` here so the client validates against the old and new shape
 * alike (a required `access_token_expires_at` would now reject every redeem).
 * What expires nowadays is the *game session* (see GameSessionRead), not the
 * Bearer: a fresh code from the bot grants a new session, and redeeming it
 * hands back a token for the same user.
 *
 * Client flow:
 *   1. POST redeem (no Bearer).
 *   2. Parse body, persist access_token in safeStorage via acceptToken().
 *   3. Subsequent protected calls carry Authorization: Bearer <access_token>.
 *   4. On a 401, wipe the token and route the user back to RedeemPage.
 */
export const RedeemCodePathSchema = z.string().min(1).max(64);
export type RedeemCodePath = z.infer<typeof RedeemCodePathSchema>;

export const AuthCodeStatusSchema = z.enum(['active', 'expired']);
export type AuthCodeStatus = z.infer<typeof AuthCodeStatusSchema>;

export const AuthCodeRedeemReadSchema = z.object({
  code: z.string(),
  status: AuthCodeStatusSchema,
  expired_at: z.string().datetime(),
  user: UserReadSchema,
  access_token: z.string().min(1),
  token_type: z.string().default('bearer'),
  redeemed_at: z.string().nullish(),
  access_token_expires_at: z.string().nullish(),
});
export type AuthCodeRedeemRead = z.infer<typeof AuthCodeRedeemReadSchema>;
