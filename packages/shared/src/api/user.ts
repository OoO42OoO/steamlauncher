import { z } from 'zod';

/**
 * GET /users/me + GET /users/{id} — self-safe projection. Email is sensitive;
 * never logged.
 *
 * `email` is OPTIONAL as of the 2026-07 API change — the backend may omit it
 * or send null. The client never reads it (it's not shown in the UI and no
 * main-process logic touches user.email), so keep it nullish rather than
 * requiring it: a required `.email()` would fail Zod validation on a
 * response without an email and break sign-in / `/users/me`.
 *
 * `balance` (added 2026-05) is the server-side authoritative balance in
 * seconds. The local SQLite ledger mirrors it and is reconciled on sign-in
 * with server-wins semantics.
 */
export const UserReadSchema = z.object({
  id: z.string().min(1),
  email: z.string().email().nullish(),
  trust_level: z.number().int().min(0).max(100),
  balance: z.number().int(),
});
export type UserRead = z.infer<typeof UserReadSchema>;

/** GET /users/{id}/balance — current authoritative balance in seconds. */
export const UserBalanceReadSchema = z.object({
  user_id: z.string().min(1),
  balance: z.number().int(),
});
export type UserBalanceRead = z.infer<typeof UserBalanceReadSchema>;

/** POST /users/{id}/balance/adjust — request body. `amount` is always
 *  positive; sign is encoded in `operation`. */
export const UserBalanceAdjustSchema = z.object({
  operation: z.enum(['plus', 'minus']),
  amount: z.number().int().min(1),
});
export type UserBalanceAdjust = z.infer<typeof UserBalanceAdjustSchema>;

/** POST /users/{id}/balance/adjust — response body. */
export const UserBalanceAdjustReadSchema = z.object({
  user_id: z.string().min(1),
  operation: z.enum(['plus', 'minus']),
  amount: z.number().int(),
  balance_before: z.number().int(),
  balance_after: z.number().int(),
});
export type UserBalanceAdjustRead = z.infer<typeof UserBalanceAdjustReadSchema>;
