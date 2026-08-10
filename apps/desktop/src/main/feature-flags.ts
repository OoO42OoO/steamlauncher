/**
 * Runtime feature flags for the desktop client.
 *
 * Currently exposes a single flag: `balanceEnabled`, which gates the entire
 * "game time / balance" subsystem (UI display, enforcer ticking, pre-launch
 * balance check). Resolution order, highest priority first:
 *
 *   1. the API `GET /balance-enabled` — server-side truth. Result is cached
 *      for 5 minutes; while the cached value is fresh we serve it directly.
 *      Stale-while-revalidate: a refresh() call past the TTL returns the
 *      previous value immediately and kicks off a background fetch so the
 *      caller never blocks on the network. Successful fetch → invokes
 *      listeners if the boolean changed.
 *   2. `STEAM_CLIENT_BALANCE_ENABLED` env var — `'false'` (case-insensitive)
 *      flips it off, anything else is treated as on. Used during boot
 *      before the first API roundtrip and as fallback when the API errors.
 *   3. `settings.json` field `balanceEnabled` — manual override persisted
 *      across runs.
 *   4. Default `true`.
 *
 * Logging: every resolution emits `[feature-flags] flag from <source>` so
 * we can tell which source won in production logs.
 *
 * Notify on change: `onFeatureFlagsChange(cb)` fires whenever the resolved
 * snapshot differs from the last published one. main/index.ts uses this to
 * broadcast 'feature-flags:changed' to the renderer over IPC.
 */
import { existsSync, readFileSync } from 'node:fs';
import log from 'electron-log/main.js';
import { paths } from './paths';
import type { ApiClient } from './api/client';

export interface FeatureFlags {
  balanceEnabled: boolean;
}

type FlagsListener = (flags: FeatureFlags) => void;
type Source = 'api' | 'env' | 'settings' | 'default';

const TTL_MS = 5 * 60_000;

let api: ApiClient | null = null;
let apiValue: boolean | null = null;
let apiFetchedAt = 0;
let inFlight: Promise<boolean | null> | null = null;
let published: FeatureFlags | null = null;
const listeners = new Set<FlagsListener>();

export function configureFeatureFlags(client: ApiClient): void {
  api = client;
}

function readEnv(): boolean | null {
  const raw = process.env.STEAM_CLIENT_BALANCE_ENABLED;
  if (raw === undefined) return null;
  if (raw.trim().toLowerCase() === 'false') return false;
  return true;
}

function readSettingsField(): boolean | null {
  try {
    if (!existsSync(paths.settings)) return null;
    const raw = readFileSync(paths.settings, 'utf8');
    const parsed = JSON.parse(raw) as { balanceEnabled?: unknown };
    if (typeof parsed.balanceEnabled === 'boolean') return parsed.balanceEnabled;
    return null;
  } catch (err) {
    log.warn('[feature-flags] settings read failed:', (err as Error).message);
    return null;
  }
}

function resolveLocal(): { value: boolean; source: Exclude<Source, 'api'> } {
  const env = readEnv();
  if (env !== null) return { value: env, source: 'env' };
  const field = readSettingsField();
  if (field !== null) return { value: field, source: 'settings' };
  return { value: true, source: 'default' };
}

function publish(value: boolean, source: Source): FeatureFlags {
  log.info(`[feature-flags] flag from ${source}: balanceEnabled=${value}`);
  const next: FeatureFlags = { balanceEnabled: value };
  const prev = published;
  published = next;
  if (!prev || prev.balanceEnabled !== next.balanceEnabled) {
    for (const cb of listeners) {
      try {
        cb(next);
      } catch (err) {
        log.warn('[feature-flags] listener threw:', (err as Error).message);
      }
    }
  }
  return next;
}

function snapshot(): FeatureFlags {
  if (apiValue !== null) return publish(apiValue, 'api');
  const local = resolveLocal();
  return publish(local.value, local.source);
}

async function fetchFromApi(): Promise<boolean | null> {
  if (!api) return null;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const v = await api!.getBalanceEnabled();
      apiValue = v;
      apiFetchedAt = Date.now();
      return v;
    } catch (err) {
      log.warn('[feature-flags] API fetch failed:', (err as Error).message);
      return null;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/**
 * Return the current resolved snapshot. Hits the API on first call (or after
 * TTL expiry with no cached value); past the TTL with a cached value we
 * return immediately and refresh in the background.
 */
export async function getFeatureFlags(): Promise<FeatureFlags> {
  const fresh = apiValue !== null && Date.now() - apiFetchedAt < TTL_MS;
  if (fresh) return snapshot();
  if (apiValue !== null) {
    // Stale-while-revalidate.
    void fetchFromApi().then(() => snapshot());
    return snapshot();
  }
  await fetchFromApi();
  return snapshot();
}

/**
 * Force a refresh from the API. Used by the boot path and the 5-minute
 * interval. Returns the resolved snapshot (which may fall back to env /
 * settings / default if the API call failed and we have no cache).
 */
export async function refreshFeatureFlags(): Promise<FeatureFlags> {
  await fetchFromApi();
  return snapshot();
}

export function onFeatureFlagsChange(cb: FlagsListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Test-only: drop the cache so the next call recomputes from scratch. */
export function _resetFeatureFlagsCache(): void {
  apiValue = null;
  apiFetchedAt = 0;
  inFlight = null;
  published = null;
  api = null;
}
