import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { paths } from './paths';
import log from 'electron-log/main.js';

export type LedgerKind = 'earn' | 'spend' | 'adjust';

let db: Database.Database | null = null;

function isCantOpenError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if ((err as { code?: string }).code === 'SQLITE_CANTOPEN') return true;
  return /unable to open/i.test(err.message);
}

// Some users running a build from before b920c15 ended up with a
// steam-client.db whose ACL got stripped by the racing icacls call. The
// permissions fix landed, but the orphan file is still on disk and SQLite
// refuses to open it. Wipe the WAL triplet and retry once.
function openDbWithRecovery(): Database.Database {
  try {
    return new Database(paths.db);
  } catch (err) {
    if (!isCantOpenError(err)) throw err;
    // force=true ignores ENOENT, but EPERM/EBUSY (Windows: file held by an
    // antivirus scan or a stuck SQLite handle from a hard-killed predecessor)
    // still throws and would derail the recovery. Log per-suffix and press on:
    // the second `new Database(...)` will fail loudly if the wipe was truly
    // incomplete, which is a clearer error than a thrown rmSync.
    for (const suffix of ['', '-shm', '-wal']) {
      try {
        rmSync(paths.db + suffix, { force: true });
      } catch (rmErr) {
        log.warn(
          '[ledger] failed to wipe stale DB sidecar',
          paths.db + suffix,
          (rmErr as Error).message
        );
      }
    }
    log.warn('[ledger] db file was unreadable, recovered by recreating');
    return new Database(paths.db);
  }
}

export function initLedger(): Database.Database {
  if (db) return db;
  db = openDbWithRecovery();
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS installs (
      appid      INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      path       TEXT,
      status     TEXT NOT NULL CHECK (status IN ('downloading','installed','error')),
      size_bytes INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT NOT NULL CHECK (kind IN ('earn','spend','adjust')),
      seconds    INTEGER NOT NULL,
      reason     TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS play_sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      appid      INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at   INTEGER,
      seconds    INTEGER,
      reason     TEXT
    );

    CREATE TABLE IF NOT EXISTS site_times (
      domain         TEXT PRIMARY KEY,
      seconds_total  INTEGER NOT NULL DEFAULT 0,
      updated_at     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS update_checks (
      appid       INTEGER PRIMARY KEY,
      checked_at  INTEGER NOT NULL,
      had_update  INTEGER NOT NULL CHECK (had_update IN (0, 1))
    );

    CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger(created_at);
  `);
  log.info('[ledger] initialized at', paths.db);
  return db;
}

function getDb(): Database.Database {
  if (!db) return initLedger();
  return db;
}

// ── balance change broadcast ────────────────────────────────────────────
type BalanceListener = (seconds: number) => void;
const balanceListeners = new Set<BalanceListener>();

/**
 * Subscribe to balance changes. The callback runs synchronously after
 * every successful `earn`/`spend`. Returns an unsubscribe function.
 */
export function onBalanceChange(cb: BalanceListener): () => void {
  balanceListeners.add(cb);
  return () => {
    balanceListeners.delete(cb);
  };
}

function notifyBalance(seconds: number): void {
  for (const l of balanceListeners) {
    try {
      l(seconds);
    } catch {
      // swallow — one bad listener must not block the rest
    }
  }
}

export function getBalance(): number {
  const row = getDb()
    .prepare<[], { balance: number | null }>(
      `SELECT COALESCE(SUM(
        CASE kind
          WHEN 'earn'   THEN seconds
          WHEN 'spend'  THEN -seconds
          WHEN 'adjust' THEN seconds
          ELSE 0
        END
      ), 0) AS balance FROM ledger`
    )
    .get();
  return Math.max(0, row?.balance ?? 0);
}

const insertLedger = () =>
  getDb().prepare(
    'INSERT INTO ledger (kind, seconds, reason, created_at) VALUES (?, ?, ?, ?)'
  );

export function earn(seconds: number, reason: string): number {
  if (seconds <= 0) throw new Error('earn: seconds must be positive');
  insertLedger().run('earn', seconds, reason, Date.now());
  const bal = getBalance();
  log.info('[ledger] earn', seconds, reason, '-> balance', bal);
  notifyBalance(bal);
  return bal;
}

/**
 * True if a ledger row with this exact `reason` already exists. Used by the
 * interim task-reward flow to avoid double-crediting if the user clicks
 * "Completed" twice or if PATCH /tasks is retried.
 */
export function hasLedgerReason(reason: string): boolean {
  const row = getDb()
    .prepare<[string], { n: number }>('SELECT COUNT(*) AS n FROM ledger WHERE reason = ?')
    .get(reason);
  return (row?.n ?? 0) > 0;
}

/**
 * Atomic `spend`. Runs the (select balance, insert spend) pair inside a
 * SQLite transaction so concurrent earn/spend on the same WAL writer cannot
 * race. better-sqlite3 is synchronous but node-level concurrency around the
 * getBalance → insert window was still observable.
 *
 * TODO: spend stays local-only until the backend exposes a session/usage
 * endpoint (no /sessions, /usage, or /tick in openapi as of 2026-05-19). The
 * authoritative server balance won't reflect gameplay until that lands; we
 * pick the lower of local vs. server in `ledger:balance` to avoid showing the
 * user phantom seconds they've already burnt.
 */
export function spend(seconds: number, reason: string): number {
  if (seconds <= 0) throw new Error('spend: seconds must be positive');
  const txn = getDb().transaction(() => {
    const cur = getBalance();
    const amount = Math.min(seconds, cur);
    if (amount > 0) {
      insertLedger().run('spend', amount, reason, Date.now());
    }
    return getBalance();
  });
  const bal = txn();
  notifyBalance(bal);
  return bal;
}

export function openPlaySession(appid: number): number {
  const info = getDb()
    .prepare('INSERT INTO play_sessions (appid, started_at) VALUES (?, ?)')
    .run(appid, Date.now());
  return Number(info.lastInsertRowid);
}

export function closePlaySession(id: number, seconds: number, reason: string): void {
  getDb()
    .prepare(
      'UPDATE play_sessions SET ended_at = ?, seconds = ?, reason = ? WHERE id = ?'
    )
    .run(Date.now(), seconds, reason, id);
}

export function upsertInstall(
  appid: number,
  name: string,
  status: 'downloading' | 'installed' | 'error',
  installPath: string | null = null,
  sizeBytes: number | null = null
): void {
  getDb()
    .prepare(
      `INSERT INTO installs (appid, name, path, status, size_bytes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(appid) DO UPDATE SET
         name = excluded.name,
         path = excluded.path,
         status = excluded.status,
         size_bytes = excluded.size_bytes,
         updated_at = excluded.updated_at`
    )
    .run(appid, name, installPath, status, sizeBytes, Date.now());
}

export function removeInstall(appid: number): void {
  getDb().prepare('DELETE FROM installs WHERE appid = ?').run(appid);
}

export function getInstall(appid: number): {
  appid: number;
  name: string;
  path: string | null;
  status: 'downloading' | 'installed' | 'error';
} | undefined {
  return getDb()
    .prepare<[number], { appid: number; name: string; path: string | null; status: 'downloading' | 'installed' | 'error' }>(
      'SELECT appid, name, path, status FROM installs WHERE appid = ?'
    )
    .get(appid);
}

/**
 * Read the most recent DD -validate verdict for this appid. The launch
 * flow uses it to skip a redundant network round-trip when we've recently
 * confirmed the install is up to date — DD -validate is a 10–30s login +
 * manifest fetch, and a healthy installed game doesn't churn that often.
 */
export function getLastUpdateCheck(
  appid: number
): { checked_at: number; had_update: boolean } | undefined {
  const row = getDb()
    .prepare<[number], { checked_at: number; had_update: number }>(
      'SELECT checked_at, had_update FROM update_checks WHERE appid = ?'
    )
    .get(appid);
  if (!row) return undefined;
  return { checked_at: row.checked_at, had_update: row.had_update === 1 };
}

export function recordUpdateCheck(appid: number, hadUpdate: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO update_checks (appid, checked_at, had_update)
       VALUES (?, ?, ?)
       ON CONFLICT(appid) DO UPDATE SET
         checked_at = excluded.checked_at,
         had_update = excluded.had_update`
    )
    .run(appid, Date.now(), hadUpdate ? 1 : 0);
}

export function listInstalls(): Array<{
  appid: number;
  status: string;
  path: string | null;
  name: string;
}> {
  return getDb()
    .prepare<[], { appid: number; status: string; path: string | null; name: string }>(
      'SELECT appid, status, path, name FROM installs'
    )
    .all();
}

/**
 * Close any play_sessions left open by a prior crash / SIGKILL of the client.
 * Called once on startup. The lost seconds are approximated from (now -
 * started_at), capped at 24h so a badly stale row doesn't refund infinite
 * minutes.
 */
export function recoverOrphanedSessions(): number {
  const db = getDb();
  const rows = db
    .prepare<[], { id: number; started_at: number }>(
      'SELECT id, started_at FROM play_sessions WHERE ended_at IS NULL'
    )
    .all();
  if (rows.length === 0) return 0;
  const now = Date.now();
  const update = db.prepare(
    'UPDATE play_sessions SET ended_at = ?, seconds = ?, reason = ? WHERE id = ?'
  );
  const txn = db.transaction(() => {
    for (const row of rows) {
      const seconds = Math.min(86400, Math.floor((now - row.started_at) / 1000));
      update.run(now, Math.max(0, seconds), 'crash_recovery', row.id);
    }
  });
  txn();
  log.warn(`[ledger] recovered ${rows.length} orphaned play_sessions`);
  return rows.length;
}

/**
 * Wipe all per-user state. Called on sign-in (before seeding from server)
 * so data from a previous session cannot contaminate the new one — and so
 * we can't re-inflate server totals by double-counting already-flushed
 * play_sessions.
 */
export function clearUserTables(): void {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM play_sessions').run();
    db.prepare('DELETE FROM site_times').run();
    db.prepare('DELETE FROM ledger').run();
    // Drain the legacy balance_outbox if it still exists from a pre-fix
    // install (the CREATE was dropped in this commit, but existing DBs
    // still carry the table with pending rows tagged to the previous user).
    try {
      db.prepare('DELETE FROM balance_outbox').run();
    } catch {
      /* table doesn't exist — fresh install */
    }
  })();
  cachedServerBalance = null;
  log.info('[ledger] user tables cleared');
}

/**
 * Seed site_times with the server's cumulative total for a domain.
 * Inserts if absent, replaces if present. New heartbeats from the extension
 * then add on top of this value, and the next flush sends the correct
 * total back to the server.
 */
export function seedSiteTime(domain: string, minutes: number): void {
  if (minutes < 0) return;
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO site_times (domain, seconds_total, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(domain) DO UPDATE SET
         seconds_total = excluded.seconds_total,
         updated_at    = excluded.updated_at`
    )
    .run(domain, minutes * 60, now);
}

/**
 * Seed play_sessions with a synthetic baseline row for a game. After
 * clearUserTables() removed any history, inserting one row here makes
 * sumPlaySecondsByApp return the server's total for this appid. New
 * in-session play gets appended naturally; the flush ends up sending
 * `server_total + minutes played since sign-in`.
 */
export function seedGameBaseline(appid: number, minutes: number): void {
  if (minutes < 0) return;
  const now = Date.now();
  getDb()
    .prepare(
      'INSERT INTO play_sessions (appid, started_at, ended_at, seconds, reason) VALUES (?, ?, ?, ?, ?)'
    )
    .run(appid, now, now, minutes * 60, 'server_baseline');
}

/** Flush WAL and release the DB handle. Must run before quit. */
export function closeLedger(): void {
  if (!db) return;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    log.info('[ledger] closed cleanly');
  } catch (err) {
    log.warn('[ledger] close error:', (err as Error).message);
  }
  db = null;
}

/**
 * Total seconds played per appid. Used by metrics flush to upsert server-side.
 */
export function sumPlaySecondsByApp(): Map<number, number> {
  const rows = getDb()
    .prepare<[], { appid: number; total: number }>(
      `SELECT appid, COALESCE(SUM(seconds), 0) AS total
         FROM play_sessions
         WHERE ended_at IS NOT NULL
         GROUP BY appid`
    )
    .all();
  const out = new Map<number, number>();
  for (const r of rows) out.set(r.appid, r.total);
  return out;
}

/** Cap on distinct site_times rows. Prevents ledger-flood from a compromised
 *  extension that knows SERVER_TOKEN (or bug that never normalises the URL).
 *  10k unique domains per user is already way beyond realistic. */
const SITE_TIMES_ROW_CAP = 10_000;

/**
 * Increment site_times row atomically. Called by the local HTTP server
 * every time the browser extension reports a heartbeat.
 * If the domain isn't present yet and we're at the row cap, the report is
 * silently dropped (log + return false).
 */
export function addSiteTime(domain: string, seconds: number): boolean {
  if (seconds <= 0) return false;
  const db = getDb();
  const exists = db
    .prepare<[string], { n: number }>(
      'SELECT COUNT(*) AS n FROM site_times WHERE domain = ?'
    )
    .get(domain);
  if ((exists?.n ?? 0) === 0) {
    const count = db
      .prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM site_times')
      .get();
    if ((count?.n ?? 0) >= SITE_TIMES_ROW_CAP) {
      log.warn('[ledger] site_times cap reached, dropping', domain);
      return false;
    }
  }
  const now = Date.now();
  db.prepare(
    `INSERT INTO site_times (domain, seconds_total, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET
       seconds_total = seconds_total + excluded.seconds_total,
       updated_at    = excluded.updated_at`
  ).run(domain, seconds, now);
  return true;
}

/** Totals per domain for the metrics flusher. */
export function sumSiteSecondsByDomain(): Map<string, number> {
  const rows = getDb()
    .prepare<[], { domain: string; total: number }>(
      'SELECT domain, seconds_total AS total FROM site_times'
    )
    .all();
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.domain, r.total);
  return out;
}

// ── Server-side balance sync ────────────────────────────────────────────
//
// Earnings happen server-side: the client PATCHes /tasks/{id} with status
// =completed and the backend credits the user's balance. We then read it back
// via GET /users/{id}/balance and call reconcileWithServer() to overwrite the
// local SQLite sum. The local earn() row is an optimistic update for UX —
// the reconcile turns it into the authoritative value once the round-trip
// completes.
//
// Spend (gameplay tick) is local-only — there is no server usage endpoint
// today. See the TODO on spend() above.
//
// The previous client-side adjust path (POST /users/{id}/balance/adjust) was
// admin-only; the server treats this endpoint as authoritative override, not
// as the earn/spend channel the launcher should use. Removed in this commit.

export interface BalanceSyncApi {
  getUserBalance(userId: string): Promise<{ balance: number }>;
}

export interface BalanceSyncConfig {
  api: BalanceSyncApi;
  /** Returns the current user id or null if signed out. */
  getUserId: () => string | null;
  /** Returns true when server sync is currently enabled. */
  isEnabled: () => boolean;
  /** Optional callback fired when the server reports a new balance. Lets
   *  the host emit IPC/WS broadcasts so the renderer reflects the
   *  authoritative value. */
  onServerBalance?: (balance: number) => void;
}

const SERVER_BALANCE_TTL_MS = 30_000;

let syncCfg: BalanceSyncConfig | null = null;
let cachedServerBalance: { value: number; at: number } | null = null;

/** Wire up server-side sync. Pass null to disable (used in tests / teardown). */
export function configureBalanceSync(cfg: BalanceSyncConfig | null): void {
  syncCfg = cfg;
  cachedServerBalance = null;
}

/**
 * Read the authoritative server balance with a 30s memory cache. Returns
 * null when sync is off, no user is signed in, or the request errors with
 * no cached value to fall back on. Callers display local SQLite via
 * getBalance() as the offline fallback.
 *
 * Pass `{ force: true }` to bypass the cache — used right after PATCH
 * /tasks/{id} completes, where the cached value still reflects the
 * pre-credit balance.
 */
export async function getServerBalance(
  opts: { force?: boolean } = {}
): Promise<number | null> {
  if (!syncCfg || !syncCfg.isEnabled()) return null;
  const uid = syncCfg.getUserId();
  if (!uid) return null;
  if (
    !opts.force &&
    cachedServerBalance &&
    Date.now() - cachedServerBalance.at < SERVER_BALANCE_TTL_MS
  ) {
    return cachedServerBalance.value;
  }
  try {
    const res = await syncCfg.api.getUserBalance(uid);
    cachedServerBalance = { value: res.balance, at: Date.now() };
    syncCfg.onServerBalance?.(res.balance);
    return res.balance;
  } catch (err) {
    log.warn('[ledger] getUserBalance failed:', (err as Error).message);
    return cachedServerBalance?.value ?? null;
  }
}

/**
 * Reconcile the local ledger with an authoritative server balance. Inserts a
 * single `adjust` row carrying the delta so `getBalance()` becomes equal to
 * `serverBalance`. Negative deltas are fine — `adjust` rows have no positivity
 * check and `getBalance()` clamps the sum to 0.
 */
export function reconcileWithServer(serverBalance: number): void {
  if (!Number.isFinite(serverBalance) || serverBalance < 0) return;
  const local = getBalance();
  const delta = serverBalance - local;
  if (delta === 0) {
    cachedServerBalance = { value: serverBalance, at: Date.now() };
    return;
  }
  insertLedger().run('adjust', delta, 'server_reconcile', Date.now());
  cachedServerBalance = { value: serverBalance, at: Date.now() };
  notifyBalance(getBalance());
  log.info(
    '[ledger] reconciled with server: local',
    local,
    '→',
    serverBalance,
    `(delta ${delta})`
  );
}

/** Test-only: clear sync wiring + cache between cases. */
export function _resetBalanceSyncForTests(): void {
  syncCfg = null;
  cachedServerBalance = null;
}
