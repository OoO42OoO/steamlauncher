/**
 * Vault — the single owner of plaintext Steam-account credentials inside
 * the main process. All callers MUST go through `withAccount(id, fn)`.
 *
 * Hard rules (memory/account_secrets_ram_only.md):
 *   - AccountRead never leaves this module except via the callback parameter
 *   - no caching on disk
 *   - at most ONE AccountRead held in memory at a time
 *   - the value is wiped in `finally`
 */
import log from 'electron-log/main.js';
import type { AccountRead } from '@steam-client/shared/api';

type AccountFetcher = (accountId: string) => Promise<AccountRead>;

let fetcher: AccountFetcher | null = null;
let inFlight: { id: string; promise: Promise<unknown> } | null = null;

/** Injected by main bootstrap once the the API client exists. */
export function configureVault(fn: AccountFetcher): void {
  fetcher = fn;
}

/**
 * Scoped access: `fn` runs with the live AccountRead; returns fn's result.
 *
 * Concurrency:
 *   - Two calls with DIFFERENT accountIds at the same time: the second one
 *     throws. A single pool account session at a time keeps the attack
 *     surface minimal and avoids two plaintext-credential blobs co-resident.
 *   - Two calls with the SAME accountId at the same time: both `await` the
 *     SAME in-flight promise (serialize). Prior version would refetch and
 *     wipe the first caller's creds mid-flight — race on plaintext.
 */
export async function withAccount<R>(
  accountId: string,
  fn: (creds: AccountRead) => Promise<R>
): Promise<R> {
  log.info('[vault] withAccount', { accountId });
  if (!fetcher) {
    throw new Error('vault: fetcher not configured');
  }
  if (inFlight) {
    if (inFlight.id !== accountId) {
      throw new Error('vault: another account session is still in flight');
    }
    // Same-id concurrent call: wait for the running session before starting.
    try {
      await inFlight.promise;
    } catch {
      // swallow — first caller's error is not ours to propagate
    }
  }
  // Reserve the slot SYNCHRONOUSLY (before any await), so concurrent callers
  // observe us immediately. Previously the slot was assigned only after
  // `await fetcher(...)`, which opened a race window: a second caller saw
  // inFlight===null and started a parallel session on the same credentials.
  let release!: () => void;
  const sessionPromise = new Promise<void>((r) => {
    release = r;
  });
  inFlight = { id: accountId, promise: sessionPromise };
  let creds: AccountRead | null = null;
  try {
    creds = await fetcher!(accountId);
    return await fn(creds);
  } finally {
    if (creds) wipe(creds);
    inFlight = null;
    release();
  }
}

function wipe(obj: unknown): void {
  if (!obj || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    try {
      (obj as Record<string, unknown>)[k] = null;
    } catch {
      /* frozen */
    }
  }
}
