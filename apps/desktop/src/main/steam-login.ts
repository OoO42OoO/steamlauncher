/**
 * Thin wrapper around steam-user for logging a pool account into Steam.
 * Uses vault.withAccount for scoped access to credentials — AccountRead
 * never outlives the login attempt.
 *
 * Primary path: `logOn({ refreshToken })` using the JWT from
 * `AccountRead.steam_mafile_plain.Session.RefreshToken`. Valve issues
 * refresh tokens with ~1 year lifetime and they don't require Steam
 * Guard, so this is the quiet path for most launches.
 *
 * Fallback: classic `logOn({ accountName, password, twoFactorCode })`
 * with TOTP generated locally from `mafile.shared_secret`. Used if the
 * refreshToken is absent, rejected, or the Session block is null.
 *
 * Failure of note: `EResult 84 RateLimitExceeded`. Steam throws this
 * when the same account sees too many logins from different IPs (our
 * pool-ban scenario). On this specific error we call
 * `api.quarantineAccount(id, {hours:24, reason})` so the server stops
 * handing this account out while Steam cools down. Any other error is
 * propagated — callers decide UX.
 */
import SteamUser from 'steam-user';
import { generateAuthCode } from 'steam-totp';
import log from 'electron-log/main.js';
import { withAccount } from './vault';
import type { ApiClient } from './api/client';

// steam-user EResult numeric constants we care about. Full enum lives
// inside steam-user at runtime, but we don't need all 100+ values.
const ERESULT = {
  OK: 1,
  RateLimitExceeded: 84,
  AccountLoginDeniedNeedTwoFactor: 85,
  TwoFactorCodeMismatch: 88,
  InvalidLoginAuthCode: 65,
  InvalidPassword: 5,
};

export class SteamLoginError extends Error {
  constructor(
    public readonly code:
      | 'invalid_credentials'
      | 'two_factor_failed'
      | 'rate_limited'
      | 'no_credentials'
      | 'network'
      | 'unknown',
    message: string,
    public readonly eresult?: number
  ) {
    super(message);
    this.name = 'SteamLoginError';
  }
}

let steam: InstanceType<typeof SteamUser> | null = null;
/** account_id of the currently logged-in Steam session, or null. */
let currentSteamAccountId: string | null = null;
/** Monotonic counter so overlapping logins can't clobber each other. */
let loginToken = 0;

function getClient(): InstanceType<typeof SteamUser> {
  if (steam) return steam;
  steam = new SteamUser({
    // Isolate steam-user's cache (sentry / local session data) under our
    // XDG data dir rather than the process CWD. Not credentials, but
    // machine-specific metadata steam-user rotates over time.
    dataDirectory: null,
    autoRelogin: false,
  });
  // A single persistent 'error' listener prevents unhandled 'error' events
  // that would kill the process. Per-attempt listeners wrap these too
  // (with once()), so we just swallow unexpected late errors here.
  steam.on('error', (err: unknown) => {
    log.warn('[steam] background error:', (err as Error)?.message ?? err);
    currentSteamAccountId = null;
  });
  steam.on('disconnected', () => {
    currentSteamAccountId = null;
  });
  return steam;
}

/**
 * Log into Steam as the given pool account. If already logged in as the
 * same accountId, no-op. If logged in as a different account, logs off
 * first. Credentials live in memory only for the duration of this call
 * (vault.withAccount wipes refs in finally).
 */
export async function loginForAccount(
  accountId: string,
  api: ApiClient
): Promise<void> {
  if (currentSteamAccountId === accountId) {
    // Steam is already in the right state. Cheap: skip the whole dance.
    return;
  }
  const myToken = ++loginToken;
  const client = getClient();

  // If another account is logged in, drop it before starting the new
  // session. Steam tolerates rapid logOff/logOn cycles.
  if (currentSteamAccountId !== null) {
    try {
      client.logOff();
    } catch {
      /* ignore — we're about to re-logon */
    }
    await waitForDisconnect(client, 3000).catch(() => {
      /* best-effort — if we never see 'disconnected' we still try to logOn */
    });
    currentSteamAccountId = null;
  }

  await withAccount(accountId, async (creds) => {
    if (myToken !== loginToken) {
      throw new SteamLoginError(
        'unknown',
        'superseded by newer login attempt'
      );
    }

    const details = buildLogOnDetails(creds);
    try {
      await performLogOn(client, details);
      currentSteamAccountId = accountId;
      log.info('[steam] logged in as pool account');
    } catch (err) {
      if (err instanceof SteamLoginError && err.code === 'rate_limited') {
        // Tell the server so it stops handing this account out.
        try {
          await api.quarantineAccount(accountId, {
            hours: 24,
            reason: 'RateLimitExceeded',
          });
        } catch (qErr) {
          log.warn(
            '[steam] quarantine request failed (continuing):',
            (qErr as Error).message
          );
        }
      }
      throw err;
    }
  });
}

export function logOffSteam(): void {
  if (!steam) return;
  try {
    steam.logOff();
  } catch {
    /* noop */
  }
  currentSteamAccountId = null;
}

// ── internals ────────────────────────────────────────────────────────

type LogOnDetailsInput = {
  accountName?: string;
  password?: string;
  refreshToken?: string;
  twoFactorCode?: string;
};

function buildLogOnDetails(creds: {
  login: string;
  password: string;
  steam_mafile_plain?: {
    Session?: { RefreshToken?: string } | null;
    shared_secret?: string;
  } | null;
}): { primary: LogOnDetailsInput; fallback: LogOnDetailsInput | null } {
  const refreshToken = creds.steam_mafile_plain?.Session?.RefreshToken;
  const sharedSecret = creds.steam_mafile_plain?.shared_secret;

  const primary: LogOnDetailsInput = refreshToken
    ? { refreshToken }
    : {
        accountName: creds.login,
        password: creds.password,
        ...(sharedSecret ? { twoFactorCode: generateAuthCode(sharedSecret) } : {}),
      };

  // Fallback only makes sense if primary used refresh token; otherwise it's
  // already the classic path.
  const fallback: LogOnDetailsInput | null = refreshToken
    ? {
        accountName: creds.login,
        password: creds.password,
        ...(sharedSecret ? { twoFactorCode: generateAuthCode(sharedSecret) } : {}),
      }
    : null;

  return { primary, fallback };
}

/** Resolve when steam emits 'loggedOn', reject on 'error'/'disconnected'. */
function performLogOn(
  client: InstanceType<typeof SteamUser>,
  variants: { primary: LogOnDetailsInput; fallback: LogOnDetailsInput | null }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const attempt = (details: LogOnDetailsInput, triedFallback: boolean) => {
      const onLoggedOn = () => {
        cleanup();
        resolve();
      };
      const onError = (err: { eresult?: number; message?: string }) => {
        cleanup();
        const eresult = err?.eresult;
        const message = err?.message ?? 'Steam login error';
        if (
          !triedFallback &&
          variants.fallback &&
          (eresult === ERESULT.InvalidPassword ||
            eresult === ERESULT.AccountLoginDeniedNeedTwoFactor ||
            eresult === ERESULT.InvalidLoginAuthCode ||
            eresult === ERESULT.TwoFactorCodeMismatch)
        ) {
          // Retry with password+TOTP if the refreshToken path failed.
          log.info('[steam] refreshToken path rejected, trying fallback');
          attempt(variants.fallback, true);
          return;
        }
        reject(mapError(eresult, message));
      };
      const onDisconnected = () => {
        cleanup();
        reject(new SteamLoginError('network', 'disconnected during login'));
      };
      const cleanup = () => {
        client.off('loggedOn', onLoggedOn);
        client.off('error', onError);
        client.off('disconnected', onDisconnected);
      };
      client.once('loggedOn', onLoggedOn);
      client.once('error', onError);
      client.once('disconnected', onDisconnected);
      try {
        client.logOn(details);
      } catch (err) {
        cleanup();
        reject(new SteamLoginError('unknown', (err as Error).message));
      }
    };
    attempt(variants.primary, false);
  });
}

function waitForDisconnect(
  client: InstanceType<typeof SteamUser>,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('disconnected', onDone);
      reject(new Error('timeout waiting for disconnect'));
    }, timeoutMs);
    const onDone = () => {
      clearTimeout(timer);
      resolve();
    };
    client.once('disconnected', onDone);
  });
}

function mapError(eresult: number | undefined, message: string): SteamLoginError {
  if (eresult === ERESULT.RateLimitExceeded) {
    return new SteamLoginError('rate_limited', message, eresult);
  }
  if (eresult === ERESULT.InvalidPassword) {
    return new SteamLoginError('invalid_credentials', message, eresult);
  }
  if (
    eresult === ERESULT.AccountLoginDeniedNeedTwoFactor ||
    eresult === ERESULT.TwoFactorCodeMismatch ||
    eresult === ERESULT.InvalidLoginAuthCode
  ) {
    return new SteamLoginError('two_factor_failed', message, eresult);
  }
  return new SteamLoginError('unknown', message, eresult);
}
