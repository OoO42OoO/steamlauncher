/**
 * API client. Main-process-only. Covers ONLY the 13 whitelisted endpoints
 * — do not add calls to anything else (see the API constraints note).
 *
 * Invariants:
 *   - Bearer token lives in memory; persisted via safeStorage IF keyring is
 *     available, otherwise never touches disk (fail-closed).
 *   - 401 → wipe token, emit 'auth:expired'.
 *   - AccountRead responses are returned as-is to the caller (main-only).
 *     Downstream code wraps them in vault.ts; this module never logs or
 *     caches them.
 */
import log from 'electron-log/main.js';
import { safeStorage } from 'electron';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { z, type ZodType } from 'zod';
// Main-process module: imports from '/api' are allowed here (credential-bearing
// types). Renderer/preload must never touch this path.
import { lockFileMode } from '../paths';
import {
  AccountAvailableReadSchema,
  AccountEmailAuthCodesReadSchema,
  AccountListReadSchema,
  AccountQuarantineCreateSchema,
  AccountQuarantineReadSchema,
  AccountReadSchema,
  AuthCodeRedeemReadSchema,
  BalanceEnabledReadSchema,
  GameMetricReadSchema,
  GameSessionReadSchema,
  GameMetricUpsertSchema,
  SiteMetricReadSchema,
  SiteMetricUpsertSchema,
  TaskReadSchema,
  TaskUpdateSchema,
  UserBalanceAdjustReadSchema,
  UserBalanceAdjustSchema,
  UserBalanceReadSchema,
  UserReadSchema,
  makePageSchema,
  type AccountAvailableRead,
  type AccountEmailAuthCodesRead,
  type AccountListQuery,
  type AccountQuarantineCreate,
  type AccountQuarantineRead,
  type AccountRead,
  type AccountUpdate,
  type AuthCodeRedeemRead,
  type GameMetricListQuery,
  type GameMetricUpsert,
  type GameSessionRead,
  type SiteMetricListQuery,
  type SiteMetricUpsert,
  type TaskListQuery,
  type TaskRead,
  type TaskUpdate,
  type UserBalanceAdjust,
  type UserBalanceAdjustRead,
  type UserBalanceRead,
  type UserRead,
} from '@steam-client/shared/api';

export interface ApiConfig {
  baseUrl: string;
  timeoutMs: number;
  /** Absolute path where the encrypted Bearer is persisted (if possible). */
  tokenFilePath: string;
  /** Dev-only stub of /auth-codes/{code}/redeem when backend is down. */
  fakeRedeem?: boolean;
}

export type ApiEvent = 'auth:expired' | 'auth:granted';

export class ApiClient {
  private token: string | null = null;
  private readonly emitter = new EventEmitter();

  constructor(private readonly cfg: ApiConfig) {}

  /**
   * Read the persisted Bearer off disk. MUST be called after
   * `app.whenReady()`.
   *
   * This used to happen in the constructor, which runs at module scope —
   * before the app is ready, where `safeStorage.isEncryptionAvailable()`
   * answers false. `loadToken` read that as "this blob can never be
   * decrypted" and deleted the file, so the token was destroyed on every
   * single boot and the user was asked for a code every single time.
   */
  loadPersistedToken(): void {
    if (this.token !== null) return;
    this.token = loadToken(this.cfg.tokenFilePath);
    if (this.token) log.info('[api] Bearer restored from disk');
  }

  on(ev: ApiEvent, listener: () => void): this {
    this.emitter.on(ev, listener);
    return this;
  }

  hasToken(): boolean {
    return this.token !== null;
  }

  /**
   * Exchange a one-time code for a user identity + Bearer.
   *
   * Endpoint is public (security:[]); no Bearer on the request. The 200
   * body carries `access_token` which we persist via acceptToken() so
   * subsequent protected calls authenticate automatically.
   *
   * No retries — code is single-use. On 401 anywhere downstream we wipe
   * the token and the renderer routes the user back to RedeemPage.
   */
  async redeem(code: string): Promise<AuthCodeRedeemRead> {
    if (this.cfg.fakeRedeem) {
      const now = new Date().toISOString();
      const inAnHour = new Date(Date.now() + 3600_000).toISOString();
      const syntheticToken =
        'dev-' + Buffer.from(code).toString('base64url').slice(0, 16);
      const resp: AuthCodeRedeemRead = {
        code,
        status: 'expired',
        expired_at: now,
        user: { id: 'dev-user', email: 'dev@local', trust_level: 50, balance: 0 },
        access_token: syntheticToken,
        token_type: 'bearer',
        access_token_expires_at: inAnHour,
      };
      this.acceptToken(syntheticToken);
      return resp;
    }
    const url = `${this.cfg.baseUrl}/auth-codes/${encodeURIComponent(code)}/redeem`;
    const res = await this.rawFetch('POST', url, { auth: false, body: undefined });
    if (res.status === 404) throw new ApiError('not_found', 'Code not found');
    if (res.status === 409 || res.status === 410) {
      throw new ApiError('expired', 'Code already used or expired');
    }
    if (!res.ok) throw new ApiError('service_unavailable', `HTTP ${res.status}`);
    const body = AuthCodeRedeemReadSchema.parse(await res.json());
    this.acceptToken(body.access_token);
    return body;
  }

  logout(): void {
    this.wipeToken();
  }

  // ── /balance-enabled ─────────────────────────────────────────────────
  /** Public endpoint (security:[]). No Bearer attached. */
  async getBalanceEnabled(): Promise<boolean> {
    const res = await this.rawFetch('GET', `${this.cfg.baseUrl}/balance-enabled`, {
      auth: false,
      body: undefined,
    });
    if (!res.ok) throw await toError(res);
    const body = BalanceEnabledReadSchema.parse(await res.json());
    return body.isBalanceEnabled;
  }

  // ── /game-sessions ───────────────────────────────────────────────────
  /**
   * The caller's current game session. Cheap and safe to call before every
   * install/launch: it is NOT itself gated behind an active session, so it
   * answers 200 with `is_active: false` rather than the 403 the gated
   * endpoints (pool credentials, Guard codes, heartbeat) return.
   */
  getMyGameSession(): Promise<GameSessionRead> {
    return this.get('/game-sessions/me', GameSessionReadSchema);
  }

  // ── /users ───────────────────────────────────────────────────────────
  getUser(userId: string): Promise<UserRead> {
    return this.get(`/users/${encodeURIComponent(userId)}`, UserReadSchema);
  }

  /** Returns the user identified by the current Bearer. Available but not
   *  wired into a caller yet — kept for refresh-token / re-auth scenarios. */
  getMe(): Promise<UserRead> {
    return this.get('/users/me', UserReadSchema);
  }

  // ── /users/{id}/balance ──────────────────────────────────────────────
  /** Read the authoritative server-side balance for a user (seconds). */
  getUserBalance(userId: string): Promise<UserBalanceRead> {
    return this.get(
      `/users/${encodeURIComponent(userId)}/balance`,
      UserBalanceReadSchema
    );
  }

  /**
   * Apply a plus/minus delta against the server balance and receive the
   * before/after snapshot. `amount` must be ≥ 1 — caller drops no-ops.
   *
   * TODO: this is the ADMIN endpoint — the launcher must not call it. Earn
   * happens server-side off PATCH /tasks/{id} status=completed; spend has
   * no server-side counterpart yet. Kept here so the SDK surface still
   * matches the openapi spec for admin tooling, but unused in the desktop
   * binary. Confirmed by Alexey, 2026-05-19.
   */
  adjustUserBalance(
    userId: string,
    body: UserBalanceAdjust
  ): Promise<UserBalanceAdjustRead> {
    UserBalanceAdjustSchema.parse(body);
    return this.post(
      `/users/${encodeURIComponent(userId)}/balance/adjust`,
      body,
      UserBalanceAdjustReadSchema
    );
  }

  // ── /accounts ────────────────────────────────────────────────────────
  /** Admin list — returns public metadata + quarantine status, no creds. */
  listAccounts(q: AccountListQuery) {
    const search = buildQuery(q);
    return this.get(`/accounts?${search}`, makePageSchema(AccountListReadSchema));
  }

  /** Full AccountRead with plaintext creds. Callers MUST pass this through
   *  vault.ts and not retain it. */
  getAccount(accountId: string): Promise<AccountRead> {
    return this.get(
      `/accounts/${encodeURIComponent(accountId)}`,
      AccountReadSchema
    );
  }

  /** Pool accounts visible to this user by trust level. No credentials in
   *  this response (server strips them); only public metadata. */
  listAvailableAccounts(userId: string): Promise<AccountAvailableRead[]> {
    return this.get(
      `/accounts/available/${encodeURIComponent(userId)}`,
      z.array(AccountAvailableReadSchema)
    );
  }

  patchAccount(accountId: string, patch: AccountUpdate): Promise<AccountRead> {
    return this.patch(
      `/accounts/${encodeURIComponent(accountId)}`,
      patch,
      AccountReadSchema
    );
  }

  /**
   * Flag an account as temporarily unusable. Called when Steam returns
   * EResult 84 (RateLimitExceeded) on login to this pool account — server
   * puts the account in quarantine for `hours` and doesn't hand it to any
   * other user during that window.
   */
  quarantineAccount(
    accountId: string,
    body: AccountQuarantineCreate
  ): Promise<AccountQuarantineRead> {
    AccountQuarantineCreateSchema.parse(body);
    return this.post(
      `/accounts/${encodeURIComponent(accountId)}/quarantine`,
      body,
      AccountQuarantineReadSchema
    );
  }

  /**
   * Pull recent Steam Guard email codes from the pool account's IMAP
   * mailbox. Used as a fallback during DepotDownloader login when the
   * account has no maFile (no shared_secret to TOTP-generate from).
   *
   * 422 means the backend has no IMAP credentials seeded for this
   * account — surfaced as ApiError(invalid, "no email credentials")
   * with `status: 422` so callers can stop retrying.
   */
  getEmailAuthCodes(
    accountId: string,
    opts?: { userId?: string; limit?: number }
  ): Promise<AccountEmailAuthCodesRead> {
    const search = buildQuery({
      user_id: opts?.userId,
      limit: opts?.limit,
    });
    const path =
      `/accounts/${encodeURIComponent(accountId)}/email-auth-codes` +
      (search ? `?${search}` : '');
    return this.post(path, undefined, AccountEmailAuthCodesReadSchema);
  }

  // ── /tasks ───────────────────────────────────────────────────────────
  listTasks(q: TaskListQuery) {
    const search = buildQuery(q);
    return this.get(`/tasks?${search}`, makePageSchema(TaskReadSchema));
  }

  getTask(taskId: string): Promise<TaskRead> {
    return this.get(`/tasks/${encodeURIComponent(taskId)}`, TaskReadSchema);
  }

  patchTask(taskId: string, patch: TaskUpdate): Promise<TaskRead> {
    // Validate the outgoing body locally first so we fail fast on bad input.
    TaskUpdateSchema.parse(patch);
    return this.patch(`/tasks/${encodeURIComponent(taskId)}`, patch, TaskReadSchema);
  }

  // ── /metrics ─────────────────────────────────────────────────────────
  listGameMetrics(q: GameMetricListQuery) {
    const search = buildQuery(q);
    return this.get(`/metrics/games?${search}`, makePageSchema(GameMetricReadSchema));
  }

  /** Paginates through every game metric for this user. Used on sign-in
   *  to seed local baselines before the flusher starts. */
  async listAllGameMetrics(userId: string) {
    const items: Array<z.infer<typeof GameMetricReadSchema>> = [];
    let page = 1;
    // Guard against a runaway server returning unchanging totals.
    const MAX_PAGES = 50;
    while (page <= MAX_PAGES) {
      const res = await this.listGameMetrics({ page, limit: 100, user_id: userId });
      items.push(...res.items);
      if (items.length >= res.total) break;
      if (res.items.length === 0) break;
      page += 1;
    }
    return items;
  }

  upsertGameMetric(body: GameMetricUpsert) {
    GameMetricUpsertSchema.parse(body);
    return this.post('/metrics/games', body, GameMetricReadSchema);
  }

  listSiteMetrics(q: SiteMetricListQuery) {
    const search = buildQuery(q);
    return this.get(`/metrics/sites?${search}`, makePageSchema(SiteMetricReadSchema));
  }

  /** Paginates through every site metric for this user. */
  async listAllSiteMetrics(userId: string) {
    const items: Array<z.infer<typeof SiteMetricReadSchema>> = [];
    let page = 1;
    const MAX_PAGES = 200;
    while (page <= MAX_PAGES) {
      const res = await this.listSiteMetrics({ page, limit: 100, user_id: userId });
      items.push(...res.items);
      if (items.length >= res.total) break;
      if (res.items.length === 0) break;
      page += 1;
    }
    return items;
  }

  upsertSiteMetric(body: SiteMetricUpsert) {
    SiteMetricUpsertSchema.parse(body);
    return this.post('/metrics/sites', body, SiteMetricReadSchema);
  }

  // ── internals ────────────────────────────────────────────────────────
  private acceptToken(token: string): void {
    this.token = token;
    persistToken(this.cfg.tokenFilePath, token);
    this.emitter.emit('auth:granted');
  }

  private wipeToken(): void {
    this.token = null;
    try {
      if (existsSync(this.cfg.tokenFilePath)) unlinkSync(this.cfg.tokenFilePath);
    } catch (err) {
      log.warn('[api] failed to remove token file:', (err as Error).message);
    }
    this.emitter.emit('auth:expired');
  }

  private async rawFetch(
    method: string,
    url: string,
    opts: { auth: boolean; body: unknown }
  ): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.auth) {
      if (!this.token) throw new ApiError('service_unavailable', 'no bearer token');
      headers.Authorization = `Bearer ${this.token}`;
    }
    try {
      // `cache` / `credentials` are Undici-supported in Node 20+; cast to
      // RequestInit to appease DOM lib types.
      const init: RequestInit = {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctl.signal,
        redirect: 'error',
      };
      (init as unknown as Record<string, unknown>).cache = 'no-store';
      (init as unknown as Record<string, unknown>).credentials = 'omit';
      try {
        const res = await fetch(url, init);
        if (res.status === 401 && opts.auth) {
          this.wipeToken();
        }
        return res;
      } catch (err) {
        // Surface Undici's err.cause — bare "fetch failed" hides DNS/TLS/abort
        // diagnostics. The thrown Error stays as-is for retry/abort logic.
        const cause = (err as { cause?: { message?: string; code?: string } }).cause;
        log.warn(
          `[api] fetch failed for ${method} ${url} :`,
          (err as Error).message,
          cause
            ? `cause=${cause.code ?? '?'} ${cause.message ?? ''}`.trim()
            : 'no cause'
        );
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private async get<T>(path: string, schema: ZodType<T>): Promise<T> {
    const res = await this.rawFetch('GET', this.cfg.baseUrl + path, {
      auth: true,
      body: undefined,
    });
    if (!res.ok) throw await toError(res);
    return schema.parse(await res.json());
  }

  private async post<T>(
    path: string,
    body: unknown,
    schema: ZodType<T>
  ): Promise<T> {
    const res = await this.rawFetch('POST', this.cfg.baseUrl + path, { auth: true, body });
    if (!res.ok) throw await toError(res);
    return schema.parse(await res.json());
  }

  private async patch<T>(
    path: string,
    body: unknown,
    schema: ZodType<T>
  ): Promise<T> {
    const res = await this.rawFetch('PATCH', this.cfg.baseUrl + path, { auth: true, body });
    if (!res.ok) throw await toError(res);
    return schema.parse(await res.json());
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'expired'
      | 'service_unavailable'
      | 'invalid'
      | 'network'
      /** 403 from a game-gated endpoint — the user has no active game
       *  session and must earn a fresh code in the Telegram bot. Distinct
       *  from 'invalid' so callers can prompt instead of signing the user
       *  out: the Bearer is still perfectly valid. */
      | 'game_session_required',
    message: string,
    /** HTTP status code when the error came from a server response. */
    public readonly status?: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Marker the API puts in the 403 body for endpoints that need a live game
 *  session (pool credentials, Guard codes, heartbeat). */
const GAME_SESSION_MARKER = 'active game session is required';

async function toError(res: Response): Promise<ApiError> {
  // Drain the body so the socket can be reused. We MATCH one known literal in
  // it but never log it: on 5xx the server may echo fragments of the original
  // request back (e.g. AccountRead with plaintext login/password), and we
  // can't guarantee redaction covers arbitrary formats.
  const body = await res.text().catch(() => '');
  log.warn('[api] non-ok response', res.status);
  if (res.status === 403 && body.toLowerCase().includes(GAME_SESSION_MARKER)) {
    return new ApiError(
      'game_session_required',
      'active game session is required',
      res.status
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new ApiError('invalid', 'auth rejected', res.status);
  }
  if (res.status === 422) {
    return new ApiError('invalid', `HTTP ${res.status}`, res.status);
  }
  return new ApiError('service_unavailable', `HTTP ${res.status}`, res.status);
}

function buildQuery(obj: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    p.set(k, String(v));
  }
  return p.toString();
}

function persistToken(filePath: string, token: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    // Fail-closed: Bearer grants access to the pool. Better to re-redeem than
    // to write a plaintext token to disk.
    log.warn('[api] safeStorage unavailable — Bearer kept in RAM only');
    return;
  }
  try {
    const blob = safeStorage.encryptString(token);
    writeFileSync(filePath, blob);
    lockFileMode(filePath, 0o600);
  } catch (err) {
    log.warn('[api] failed to persist token:', (err as Error).message);
  }
}

function loadToken(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      // Keep the file. "No keyring right now" is not "this ciphertext is
      // junk" — it is true of every boot before the app is ready, and it can
      // be true transiently on Linux while the session keyring comes up.
      // Deleting here is how the Bearer used to be lost on every launch.
      log.warn('[api] safeStorage unavailable — leaving the stored Bearer alone');
      return null;
    }
    const blob = readFileSync(filePath);
    return safeStorage.decryptString(blob);
  } catch (err) {
    log.warn('[api] token load failed:', (err as Error).message);
    try {
      unlinkSync(filePath);
    } catch {
      /* ignore */
    }
    return null;
  }
}
