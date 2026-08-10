import { z } from 'zod';
import { DownloadStageSchema, GuardHintSchema } from './local/protocol';

/**
 * Renderer-safe projection of AccountRead. Only these fields cross the IPC
 * boundary from main to renderer. No login, password, email, or maFile.
 *
 * Rule enforced by convention: any IPC handler that returns account data
 * must return PublicAccount[], never AccountRead.
 */
export const PublicAccountSchema = z.object({
  id: z.string(),
  appid: z.number().int(),
  game_name: z.string(),
  iconUrl: z.string().nullable(),
  logoUrl: z.string().nullable(),
  min_trust_level: z.number().int().min(0).max(100),
  /** Derived on main side from min_trust_level vs user.trust_level. */
  locked: z.boolean(),
  /** Local install state. */
  status: z.enum(['not_installed', 'downloading', 'installed', 'error', 'running']),
  downloadPercent: z.number().nullable(),
  /**
   * What DepotDownloader is doing right now. Populated only while
   * status === 'downloading'. Cleared on completion or error.
   */
  downloadStage: DownloadStageSchema.nullable(),
  /**
   * Transient guard-fallback hint set while the email-auth-codes poll is
   * in flight (or right after a code is fed to DD). Cleared on the next
   * progress event that omits it. Renderer prefers this over
   * `downloadStage` when present.
   */
  guardHint: GuardHintSchema.nullable(),
  /**
   * Last terminal error string from the downloader (e.g. "two_factor_required",
   * "account_unconfigured", "rate_limited"). Cleared when a fresh download
   * starts. Renderer maps known codes to localized messages.
   */
  downloadError: z.string().nullable(),
  /**
   * Platforms supported by the game (per Steam Store), accompanying
   * platform-aware error keys (e.g. `unsupported_platform`,
   * `account_missing_license_other_platform`). Null otherwise.
   */
  downloadErrorPlatforms: z
    .array(z.enum(['windows', 'mac', 'linux']))
    .nullable(),
  /**
   * Bytes pulled from the CDN so far (recursive install-dir size on main).
   * Cleared on completion. Drives the "X MB / Y MB" label on the
   * download card so the user has a rough ETA.
   */
  downloadBytesDownloaded: z.number().int().nonnegative().nullable(),
  /**
   * Estimated total install size in bytes. Source priority matches
   * DownloadProgressSchema.bytesTotal: DD's `Total downloaded:` line
   * first, then a running estimate derived from the aggregate percent.
   * Cleared on completion.
   */
  downloadBytesTotal: z.number().int().nonnegative().nullable(),
});
export type PublicAccount = z.infer<typeof PublicAccountSchema>;
