import { z } from 'zod';

export const TaskStatusSchema = z.enum(['pending', 'completed']);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** GET /tasks/{id}, items of GET /tasks. */
export const TaskReadSchema = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
  title: z.string(),
  description: z.string().nullable(),
  status: TaskStatusSchema,
});
export type TaskRead = z.infer<typeof TaskReadSchema>;

/** PATCH /tasks/{id} request body. */
export const TaskUpdateSchema = z.object({
  title: z.string().min(1).max(255).nullish(),
  description: z.string().nullish(),
  status: TaskStatusSchema.nullish(),
});
export type TaskUpdate = z.infer<typeof TaskUpdateSchema>;

/** Query parameters for GET /tasks. */
export const TaskListQuerySchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  user_id: z.string().optional(),
  status: TaskStatusSchema.optional(),
});
export type TaskListQuery = z.infer<typeof TaskListQuerySchema>;
