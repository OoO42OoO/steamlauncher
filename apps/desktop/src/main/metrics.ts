/**
 * Periodic upload of play-time metrics to the API.
 * POST /metrics/games is upsert by (user_id, appid) — we send the running
 * total in minutes, so retries are idempotent and out-of-order delivery is
 * self-healing.
 *
 * Site metrics are produced by the browser extension and forwarded through
 * this flusher too; main-side placeholder for now, wired in Sprint 2.
 */
import log from 'electron-log/main.js';
import { sumPlaySecondsByApp, sumSiteSecondsByDomain } from './ledger';
import type { ApiClient } from './api/client';
import type { PublicAccount } from '@steam-client/shared';

type MetricsDeps = {
  api: ApiClient;
  getUserId: () => string | null;
  getLibrary: () => PublicAccount[];
  /** Returns the account_id the user was last handed for this appid, or
   *  null if we've never given them one (e.g. they never launched). */
  getAccountIdForApp: (appid: number) => string | null;
  intervalMs: number;
};

let timer: NodeJS.Timeout | null = null;
// Avoid re-POSTing the same number repeatedly.
const lastSentGameMinutes = new Map<number, number>();
const lastSentSiteMinutes = new Map<string, number>();

// Per-key exponential backoff. If a key fails, retry is deferred to
// now + min(60 * 2^n, 3600)s. On success the counter resets. Without this
// a long API outage produces N keys × M ticks/hour failed requests.
type BackoffState = { failures: number; skipUntil: number };
const gameBackoff = new Map<number, BackoffState>();
const siteBackoff = new Map<string, BackoffState>();

function shouldSkip(st: BackoffState | undefined): boolean {
  return !!st && st.skipUntil > Date.now();
}

function onSuccess(map: Map<unknown, BackoffState>, key: unknown): void {
  map.delete(key);
}

function onFailure(map: Map<unknown, BackoffState>, key: unknown): void {
  const prev = map.get(key);
  const failures = (prev?.failures ?? 0) + 1;
  const delayMs = Math.min(60 * 2 ** failures, 3600) * 1000;
  map.set(key, { failures, skipUntil: Date.now() + delayMs });
}

export function startMetricsFlush(deps: MetricsDeps): void {
  if (timer) return;
  log.info('[metrics] flush timer starting, interval=', deps.intervalMs);
  timer = setInterval(() => {
    void flushOnce(deps).catch((err) => {
      log.warn('[metrics] flush error:', (err as Error).message);
    });
  }, deps.intervalMs);
}

export function stopMetricsFlush(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    lastSentGameMinutes.clear();
    lastSentSiteMinutes.clear();
    gameBackoff.clear();
    siteBackoff.clear();
    log.info('[metrics] flush timer stopped');
  }
}

async function flushOnce(deps: MetricsDeps): Promise<void> {
  const userId = deps.getUserId();
  if (!userId) return;
  await Promise.all([flushGames(deps, userId), flushSites(deps, userId)]);
}

async function flushGames(deps: MetricsDeps, userId: string): Promise<void> {
  const totals = sumPlaySecondsByApp();
  if (totals.size === 0) return;
  const library = deps.getLibrary();
  const nameByApp = new Map<number, string>();
  for (const g of library) nameByApp.set(g.appid, g.game_name);

  for (const [appid, seconds] of totals) {
    const minutes = Math.floor(seconds / 60);
    if (minutes <= 0) continue;
    if (lastSentGameMinutes.get(appid) === minutes) continue;
    if (shouldSkip(gameBackoff.get(appid))) continue;
    const accountId = deps.getAccountIdForApp(appid);
    if (!accountId) {
      // play_sessions has this appid but no launch through the pool was
      // recorded — shouldn't happen in the current flow; skip to avoid
      // sending an invalid metric.
      continue;
    }
    try {
      await deps.api.upsertGameMetric({
        user_id: userId,
        account_id: accountId,
        appid,
        game_name: nameByApp.get(appid) ?? `App ${appid}`,
        play_time_minutes: minutes,
      });
      lastSentGameMinutes.set(appid, minutes);
      onSuccess(gameBackoff as Map<unknown, BackoffState>, appid);
    } catch (err) {
      onFailure(gameBackoff as Map<unknown, BackoffState>, appid);
      log.warn(
        `[metrics] upsertGameMetric failed for appid=${appid}:`,
        (err as Error).message
      );
    }
  }
}

async function flushSites(deps: MetricsDeps, userId: string): Promise<void> {
  const totals = sumSiteSecondsByDomain();
  if (totals.size === 0) return;
  for (const [domain, seconds] of totals) {
    const minutes = Math.floor(seconds / 60);
    if (minutes <= 0) continue;
    if (lastSentSiteMinutes.get(domain) === minutes) continue;
    if (shouldSkip(siteBackoff.get(domain))) continue;
    try {
      await deps.api.upsertSiteMetric({
        user_id: userId,
        domain,
        time_spent_minutes: minutes,
      });
      lastSentSiteMinutes.set(domain, minutes);
      onSuccess(siteBackoff as Map<unknown, BackoffState>, domain);
    } catch (err) {
      onFailure(siteBackoff as Map<unknown, BackoffState>, domain);
      log.warn(
        `[metrics] upsertSiteMetric failed for domain=${domain}:`,
        (err as Error).message
      );
    }
  }
}
