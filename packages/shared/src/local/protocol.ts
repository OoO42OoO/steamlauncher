import { z } from 'zod';
import { PublicAccountSchema } from '../public-account';
import { UserReadSchema } from '../api/user';

// ──────────────────────────────────────────────────────────────────────────
// IPC main ↔ renderer and WS main ↔ extension.
// No credential fields allowed here by policy — see
// memory/account_secrets_ram_only.md.
// ──────────────────────────────────────────────────────────────────────────

/** Session status exposed to the renderer. Never carries Steam-account data. */
export const SessionStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('signed_out') }),
  z.object({ state: z.literal('redeeming') }),
  z.object({ state: z.literal('signed_in'), user: UserReadSchema }),
  z.object({ state: z.literal('error'), error: z.string() }),
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/** Renderer-facing library entry is just a PublicAccount. */
export type LibraryEntry = z.infer<typeof PublicAccountSchema>;

export const RedeemRequestSchema = z.object({
  code: z.string().min(1).max(64),
});
export type RedeemRequest = z.infer<typeof RedeemRequestSchema>;

export const RedeemResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    error: z.enum(['not_found', 'expired', 'network', 'service_unavailable', 'invalid']),
    message: z.string().optional(),
  }),
]);
export type RedeemResult = z.infer<typeof RedeemResultSchema>;

export const LaunchRequestSchema = z.object({
  appid: z.number().int().min(1),
});
export type LaunchRequest = z.infer<typeof LaunchRequestSchema>;

/**
 * Stage of a multi-depot DepotDownloader run. A single appid like Civilization V
 * triggers several depot downloads in sequence — the renderer shows the user
 * which one is in flight so the percent doesn't appear to jump back to 0%.
 *
 * `phase` is always set; `label`/`current`/`total` are populated once we know
 * them (typically from the first `Processing depot N - <name>` line).
 *
 * Phases:
 *   connecting        — process spawned, no DD output yet.
 *   authenticating    — Steam login prompts / Steam Guard exchange.
 *   fetching_manifest — got logged in, fetching app info / depot keys.
 *   downloading       — actively downloading a depot (`label` = depot name).
 *   validating        — DD is verifying a depot's files.
 *   finalizing        — last-mile: depot writes complete, exit imminent.
 *   installing_redist — running bundled runtimes (VC++, DirectX, .NET);
 *                       `current`/`total` count the packages, `label` names
 *                       the one being installed.
 */
export const DownloadStageSchema = z.object({
  phase: z.enum([
    'queued',
    'connecting',
    'authenticating',
    'fetching_manifest',
    'downloading',
    'validating',
    'finalizing',
    'installing_redist',
  ]),
  /** Human-readable depot name when in downloading/validating phases. */
  label: z.string().optional(),
  /** 1-based index of the current depot. */
  current: z.number().int().min(1).optional(),
  /** Total depots discovered so far. May be undefined until DD reveals it. */
  total: z.number().int().min(1).optional(),
});
export type DownloadStage = z.infer<typeof DownloadStageSchema>;

/**
 * Transient hint emitted by the email-auth-codes Steam Guard fallback in
 * the downloader. Surfaces in the UI as an extra label on the download
 * card while we poll the backend's IMAP-derived code feed.
 *
 *   waiting_for_email — first prompt arrived, poll started.
 *   received          — a fresh code came back from the backend; we just
 *                       fed it to DD's stdin. Cleared on the next event.
 */
export const GuardHintSchema = z.enum(['waiting_for_email', 'received']);
export type GuardHint = z.infer<typeof GuardHintSchema>;

export const DownloadProgressSchema = z.object({
  appid: z.number().int(),
  /** Percent of the current depot/stage (0–100), not aggregate across depots. */
  percent: z.number(),
  done: z.boolean(),
  error: z.string().optional(),
  /**
   * Platforms supported by the game (per Steam Store), accompanying
   * platform-aware error keys (`unsupported_platform`,
   * `account_missing_license_other_platform`). Renderer joins them into
   * a localized list via i18n interpolation.
   */
  errorPlatforms: z.array(z.enum(['windows', 'mac', 'linux'])).optional(),
  /** Optional descriptor of what's happening right now — see DownloadStage. */
  stage: DownloadStageSchema.optional(),
  /** Steam Guard email-fallback hint; see GuardHint. */
  guardHint: GuardHintSchema.optional(),
  /**
   * Cumulative bytes DD has actually written to the install dir so far.
   * Computed in main by recursively summing the install tree (throttled
   * to ~1.5s to keep the per-progress-event cost down on big installs).
   * Renderer uses this + bytesTotal to render the "X MB / Y MB" label.
   *
   * Always present on terminal events (done: true) when the install dir
   * existed; may be omitted on the first few pre-percent events while
   * DD is still logging in.
   */
  bytesDownloaded: z.number().int().nonnegative().optional(),
  /**
   * Estimated total bytes the install will consume when complete.
   *
   * Source priority (highest first):
   *   1. DD's own `Total downloaded: X bytes from Y depots` summary line
   *      — exact, only available on terminal events.
   *   2. Running estimate: bytesDownloaded / aggregateFraction, clamped
   *      to the running max so the bar never goes backwards as the
   *      sample stabilises. Set once at least one byte of progress has
   *      been observed so we don't divide by zero at the very start.
   *
   * Renderer falls back to a simple per-depot-percent display when
   * bytesTotal is absent.
   */
  bytesTotal: z.number().int().nonnegative().optional(),
});
export type DownloadProgress = z.infer<typeof DownloadProgressSchema>;

/** WebSocket push messages from local server to the extension. */
export const WsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), version: z.string() }),
  z.object({ type: z.literal('balance'), seconds: z.number().int().nonnegative() }),
  z.object({
    type: z.literal('game'),
    status: z.enum(['running', 'stopped']),
    appid: z.number().int(),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal('download'),
    appid: z.number().int(),
    percent: z.number(),
    done: z.boolean(),
  }),
]);
export type WsMessage = z.infer<typeof WsMessageSchema>;

/** Extension reports a site visit / task completion back to main. */
export const TaskCompletedNoticeSchema = z.object({
  task_id: z.string(),
  domain: z.string().optional(),
});
export type TaskCompletedNotice = z.infer<typeof TaskCompletedNoticeSchema>;

/**
 * Extension reports an active-tab heartbeat: N seconds on a given domain.
 * Domain must look like a valid RFC-compliant hostname — we don't accept
 * whitespace, control chars, `..`, unicode etc. The upper bound follows
 * RFC 1035 (253 usable chars). Seconds capped at 1 hour per heartbeat.
 */
export const SiteTimeReportSchema = z.object({
  domain: z
    .string()
    .min(1)
    .max(253)
    .regex(/^(?!-)[a-zA-Z0-9-]{1,63}(\.[a-zA-Z0-9-]{1,63})*$/, 'invalid_hostname'),
  seconds: z.number().int().min(1).max(3600),
});
export type SiteTimeReport = z.infer<typeof SiteTimeReportSchema>;

export const HealthResponseSchema = z.object({
  ok: z.literal(true),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
