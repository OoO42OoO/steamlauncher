import { z } from 'zod';

/**
 * Shape of `steam_mafile_plain` as seen in real responses from the pool.
 * Every field here is sensitive. This schema is declared only so we can
 * type-check vault code — it MUST NOT be imported by renderer/preload.
 */
export const SteamMaFileSchema = z
  .object({
    uri: z.string().optional(),
    status: z.number().int().optional(),
    // Steam IDs exceed 2^53; zod number() loses precision but steam-user takes
    // refreshToken directly, so SteamID is not actually consumed here.
    Session: z
      .object({
        SteamID: z.number().optional(),
        SessionID: z.string().nullable().optional(),
        AccessToken: z.string().optional(),
        RefreshToken: z.string().optional(),
      })
      .passthrough()
      .optional(),
    secret_1: z.string().optional(),
    device_id: z.string().optional(),
    token_gid: z.string().optional(),
    server_time: z.number().optional(),
    account_name: z.string().optional(),
    serial_number: z.string().optional(),
    shared_secret: z.string().optional(),
    fully_enrolled: z.boolean().optional(),
    identity_secret: z.string().optional(),
    revocation_code: z.string().optional(),
  })
  .passthrough();
export type SteamMaFile = z.infer<typeof SteamMaFileSchema>;

/**
 * GET /accounts/{id} — full credentials view. Main-process only.
 * As of the 2026-04 API update, `email_login` and `email_password` are NOT
 * returned by the server; they were removed server-side for security. The
 * remaining credential fields are still plaintext.
 * HIGH SENSITIVITY — see memory/account_secrets_ram_only.md.
 */
export const AccountReadSchema = z.object({
  id: z.string().min(1),
  game_name: z.string(),
  appid: z.number().int().min(1),
  min_trust_level: z.number().int().min(0).max(100),
  guard: z.boolean(),
  login: z.string(),
  password: z.string(),
  steam_mafile_plain: SteamMaFileSchema.nullish(),
  quarantined_until: z.string().datetime().nullish(),
  quarantine_reason: z.string().nullish(),
});
export type AccountRead = z.infer<typeof AccountReadSchema>;

/**
 * GET /accounts/available/{user_id} — list item.
 * No credentials, no quarantine info. The server filters quarantined
 * accounts out of this list entirely, so clients never see them here.
 */
export const AccountAvailableReadSchema = z.object({
  id: z.string().min(1),
  game_name: z.string(),
  appid: z.number().int().min(1),
  min_trust_level: z.number().int().min(0).max(100),
  guard: z.boolean(),
});
export type AccountAvailableRead = z.infer<typeof AccountAvailableReadSchema>;

/**
 * GET /accounts — admin list item. Same as AccountAvailableRead plus
 * quarantine info so admins see the status of every pool account.
 * Also no credentials.
 */
export const AccountListReadSchema = z.object({
  id: z.string().min(1),
  game_name: z.string(),
  appid: z.number().int().min(1),
  min_trust_level: z.number().int().min(0).max(100),
  guard: z.boolean(),
  quarantined_until: z.string().datetime().nullish(),
  quarantine_reason: z.string().nullish(),
});
export type AccountListRead = z.infer<typeof AccountListReadSchema>;

/** PATCH /accounts/{id} request body. */
export const AccountUpdateSchema = z.object({
  game_name: z.string().min(1).max(255).nullish(),
  appid: z.number().int().min(1).nullish(),
  min_trust_level: z.number().int().min(0).max(100).nullish(),
  guard: z.boolean().nullish(),
  login: z.string().min(1).max(255).nullish(),
  password: z.string().min(1).max(255).nullish(),
  steam_mafile_plain: SteamMaFileSchema.nullish(),
});
export type AccountUpdate = z.infer<typeof AccountUpdateSchema>;

/** POST /accounts/{id}/quarantine request body. */
export const AccountQuarantineCreateSchema = z.object({
  hours: z.number().int().min(12).max(24).default(24),
  reason: z.string().min(1).max(255).default('RateLimitExceeded'),
});
export type AccountQuarantineCreate = z.infer<typeof AccountQuarantineCreateSchema>;

/** POST /accounts/{id}/quarantine response body. */
export const AccountQuarantineReadSchema = z.object({
  id: z.string(),
  quarantined_until: z.string().datetime(),
  quarantine_reason: z.string(),
});
export type AccountQuarantineRead = z.infer<typeof AccountQuarantineReadSchema>;

/** Query parameters for GET /accounts. */
export const AccountListQuerySchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100).default(20),
  appid: z.number().int().min(1).optional(),
  game_name: z.string().optional(),
  min_trust_level: z.number().int().min(0).max(100).optional(),
});
export type AccountListQuery = z.infer<typeof AccountListQuerySchema>;

/**
 * Single Steam Guard email code parsed from the pool account's mailbox.
 * Backend implements POST /accounts/{id}/email-auth-codes by connecting to
 * the account's IMAP inbox (creds seeded server-side) and extracting the
 * 5-letter code from recent Steam access-from-new-computer messages.
 *
 * `received_at` is the only filter we trust: codes older than the current
 * DD login attempt are useless because Steam only honours the latest one.
 */
export const AccountEmailAuthCodeReadSchema = z
  .object({
    code: z.string(),
    subject: z.string().nullable().optional(),
    from_email: z.string().nullable().optional(),
    received_at: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .passthrough();
export type AccountEmailAuthCodeRead = z.infer<typeof AccountEmailAuthCodeReadSchema>;

/**
 * POST /accounts/{id}/email-auth-codes response.
 *
 * 422 ("Account does not have email credentials") is reported as a normal
 * the API error by the client — callers should cache that verdict and stop
 * polling. 200 with an empty `codes` array means "no recent Steam mail
 * found in the inbox window" — caller should keep polling.
 */
export const AccountEmailAuthCodesReadSchema = z
  .object({
    account_id: z.string(),
    email_login_masked: z.string(),
    imap_host: z.string(),
    mailbox: z.string(),
    messages_scanned: z.number().int(),
    retrieved_at: z.string().datetime({ offset: true }),
    codes: z.array(AccountEmailAuthCodeReadSchema),
  })
  .passthrough();
export type AccountEmailAuthCodesRead = z.infer<typeof AccountEmailAuthCodesReadSchema>;
