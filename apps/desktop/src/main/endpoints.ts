/**
 * Where this build talks to.
 *
 * The service's hostnames are deployment configuration, not source: nothing
 * in the repository names them. They are supplied by the environment at
 * build time (electron.vite.config.ts inlines them) and can be overridden by
 * the same environment variables at run time, which is what a dev pointing
 * at a local API does.
 *
 * A build made without them produces an app that cannot reach the service at
 * all, so the failure is made loud rather than mysterious: the API resolver
 * throws, and the caller surfaces it. The updater is treated as optional —
 * a build with no feed simply never offers updates, which is a coherent
 * thing to want and not worth refusing to start over.
 */
import log from 'electron-log/main.js';

function fromBuild(name: string): string {
  try {
    if (name === 'API_BASE_URL') return __API_BASE_URL__ ?? '';
    return __UPDATES_FEED_URL__ ?? '';
  } catch {
    // Not running through the bundler (unit tests, ts-node) — env only.
    return '';
  }
}

function resolve(name: 'API_BASE_URL' | 'STEAM_CLIENT_UPDATES_URL'): string {
  const raw = process.env[name] || fromBuild(name);
  return raw.trim().replace(/\/+$/, '');
}

let warnedNoFeed = false;

/**
 * Base URL of the API, without a trailing slash.
 * @throws when neither the build nor the environment supplied one.
 */
export function apiBaseUrl(): string {
  const url = resolve('API_BASE_URL');
  if (!url) {
    throw new Error(
      'API_BASE_URL is not configured. Set it in the environment before ' +
        'building (see .env.example) or when starting the app.'
    );
  }
  return url;
}

/** Origin of the API, for the connect-src the renderer is allowed to reach. */
export function apiOrigin(): string {
  return new URL(apiBaseUrl()).origin;
}

/** Update feed, or null when this build was made without one. */
export function updatesFeedUrl(): string | null {
  const url = resolve('STEAM_CLIENT_UPDATES_URL');
  if (!url) {
    if (!warnedNoFeed) {
      warnedNoFeed = true;
      log.info('[updater] no feed configured — auto-update is off for this build');
    }
    return null;
  }
  return url;
}
