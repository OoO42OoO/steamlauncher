import log from 'electron-log/main.js';

const SCHEME = 'steam-client:';

/**
 * Queued one-time redeem code parsed from a deeplink before the renderer is
 * ready. Consumed once the UI mounts.
 */
let pendingCode: string | null = null;

/**
 * Parse `steam-client://redeem?code=XXXX` (also accepts `:redeem` without `//`).
 * Returns the raw code string, or null if the URL is unrelated / malformed.
 * Legacy password-based form (`steam-client://login?username=&password=`) is
 * ignored intentionally — that flow is gone.
 */
export function parseDeeplink(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== SCHEME) return null;
    const path = (u.host || u.pathname || '').replace(/^\/+/, '');
    if (!path.startsWith('redeem')) {
      log.warn('[deeplink] unsupported action:', path);
      return null;
    }
    const code = u.searchParams.get('code')?.trim();
    if (!code) {
      log.warn('[deeplink] missing code');
      return null;
    }
    if (code.length > 64) {
      log.warn('[deeplink] code too long, ignored');
      return null;
    }
    return code;
  } catch (err) {
    log.warn('[deeplink] parse failed:', (err as Error).message);
    return null;
  }
}

export function setPendingCode(code: string): void {
  log.info('[deeplink] redeem code queued');
  pendingCode = code;
}

export function takePendingCode(): string | null {
  const c = pendingCode;
  pendingCode = null;
  return c;
}

export function hasPendingCode(): boolean {
  return pendingCode !== null;
}

export function extractDeeplinkFromArgv(argv: readonly string[]): string | null {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith(SCHEME)) {
      return arg;
    }
  }
  return null;
}
