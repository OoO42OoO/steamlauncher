import { z } from 'zod';

/**
 * GET /balance-enabled — public. Server-side gate for the balance/game-time
 * subsystem. Field is camelCase per the backend's actual response shape.
 */
export const BalanceEnabledReadSchema = z.object({
  isBalanceEnabled: z.boolean(),
});
export type BalanceEnabledRead = z.infer<typeof BalanceEnabledReadSchema>;
