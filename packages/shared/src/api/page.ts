import { z, type ZodType } from 'zod';

/**
 * Generic paginated envelope used by GET /accounts, /tasks, /metrics/*.
 * Usage: `const Page = makePageSchema(TaskReadSchema)`.
 */
export function makePageSchema<T extends ZodType>(itemSchema: T) {
  return z.object({
    items: z.array(itemSchema),
    page: z.number().int().min(1),
    limit: z.number().int().min(1).max(100),
    total: z.number().int().min(0),
  });
}

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

export const PageQuerySchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;
