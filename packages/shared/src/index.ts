/**
 * Root barrel of @steam-client/shared — **safe-by-default** surface.
 *
 * Credential types (AccountRead, AccountUpdate, SteamMaFile) and the
 * account subset of the API are INTENTIONALLY NOT exported here. To
 * touch them, explicitly import from `@steam-client/shared/api`. This
 * makes accidental credential imports in renderer/preload/extension
 * code a compile error rather than a review-catch.
 */
export * from './local';
export * from './public-account';
export * from './sensitive';

// Safe API types (no plaintext Steam credentials).
export {
  UserReadSchema,
  type UserRead,
} from './api/user';
export {
  TaskReadSchema,
  TaskStatusSchema,
  TaskUpdateSchema,
  TaskListQuerySchema,
  type TaskRead,
  type TaskStatus,
  type TaskUpdate,
  type TaskListQuery,
} from './api/task';
export {
  GameMetricReadSchema,
  GameMetricUpsertSchema,
  GameMetricListQuerySchema,
  SiteMetricReadSchema,
  SiteMetricUpsertSchema,
  SiteMetricListQuerySchema,
  type GameMetricRead,
  type GameMetricUpsert,
  type GameMetricListQuery,
  type SiteMetricRead,
  type SiteMetricUpsert,
  type SiteMetricListQuery,
} from './api/metrics';
export {
  AuthCodeRedeemReadSchema,
  AuthCodeStatusSchema,
  RedeemCodePathSchema,
  type AuthCodeRedeemRead,
  type AuthCodeStatus,
  type RedeemCodePath,
} from './api/auth';
export {
  makePageSchema,
  PageQuerySchema,
  type Page,
  type PageQuery,
} from './api/page';
