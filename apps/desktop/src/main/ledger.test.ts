import { beforeEach, describe, expect, it, vi } from 'vitest';

// ledger.ts opens a better-sqlite3 DB at `paths.db` on first call. Point that
// at an in-memory DB so the test never touches disk and starts clean.
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    setName: () => {},
    isPackaged: false,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));
vi.mock('./paths', () => ({
  paths: { db: ':memory:' },
  lockFileMode: () => {},
  ensurePaths: () => {},
}));

import {
  _resetBalanceSyncForTests,
  clearUserTables,
  configureBalanceSync,
  earn,
  getBalance,
  getInstall,
  getServerBalance,
  hasLedgerReason,
  initLedger,
  listInstalls,
  onBalanceChange,
  reconcileWithServer,
  removeInstall,
  spend,
  upsertInstall,
} from './ledger';

beforeEach(() => {
  // Make sure the singleton is initialized, then wipe per-user tables so each
  // test starts from a known state. (initLedger is idempotent.)
  initLedger();
  clearUserTables();
  _resetBalanceSyncForTests();
});

describe('ledger.earn', () => {
  it('credits the balance and notifies listeners', () => {
    const seen: number[] = [];
    const off = onBalanceChange((b) => seen.push(b));
    earn(120, 'task:a');
    expect(getBalance()).toBe(120);
    expect(seen).toEqual([120]);
    off();
  });

  it('rejects non-positive seconds', () => {
    expect(() => earn(0, 'task:zero')).toThrow(/positive/);
    expect(() => earn(-5, 'task:neg')).toThrow(/positive/);
  });

  it('does NOT dedupe by reason at the API level (no UNIQUE index)', () => {
    // Documented behaviour: earn() does not check `hasLedgerReason` itself.
    // Caller-side dedup is the contract — see main/index.ts task-complete
    // handler. Pin this so a future change to earn() doesn't silently break
    // the contract without updating callers.
    earn(3600, 'task:abc');
    earn(3600, 'task:abc');
    expect(getBalance()).toBe(7200);
  });

  it('hasLedgerReason() returns true after the first earn with that reason', () => {
    expect(hasLedgerReason('task:once')).toBe(false);
    earn(3600, 'task:once');
    expect(hasLedgerReason('task:once')).toBe(true);
    expect(hasLedgerReason('task:never')).toBe(false);
  });

  it('caller-side idempotency pattern using hasLedgerReason+earn works', () => {
    const reason = 'task:idem';
    const safeEarn = (s: number, r: string) => {
      if (hasLedgerReason(r)) return;
      earn(s, r);
    };
    safeEarn(3600, reason);
    safeEarn(3600, reason);
    safeEarn(3600, reason);
    expect(getBalance()).toBe(3600);
  });
});

describe('ledger.spend', () => {
  it('debits the requested seconds when balance is sufficient', () => {
    earn(500, 'task:fund');
    const balAfter = spend(120, 'play:civ5');
    expect(balAfter).toBe(380);
    expect(getBalance()).toBe(380);
  });

  it('clamps the spend at the current balance — never goes negative', () => {
    earn(100, 'task:short');
    const balAfter = spend(150, 'play:bignet');
    // We started at 100s; spend(150) caps at 100s. Final balance is 0.
    expect(balAfter).toBe(0);
    expect(getBalance()).toBe(0);
  });

  it('inserts NO ledger row when balance is already zero', () => {
    // The spend() implementation only inserts when amount > 0. So a no-op
    // spend leaves the ledger empty and getBalance still returns 0 — and
    // crucially the balance never dips negative even with multiple no-ops.
    expect(spend(60, 'play:none')).toBe(0);
    expect(spend(60, 'play:still-none')).toBe(0);
    expect(getBalance()).toBe(0);
  });

  it('rejects non-positive seconds', () => {
    expect(() => spend(0, 'play:zero')).toThrow(/positive/);
    expect(() => spend(-3, 'play:neg')).toThrow(/positive/);
  });

  it('notifies balance listeners after each spend', () => {
    earn(200, 'task:x');
    const seen: number[] = [];
    const off = onBalanceChange((b) => seen.push(b));
    spend(50, 'play:a');
    spend(1000, 'play:overdraft'); // clamped, ends at 0
    expect(seen).toEqual([150, 0]);
    off();
  });

  it('keeps balance non-negative across an interleaved earn/spend sequence', () => {
    earn(60, 'task:1');
    spend(30, 'play:1');
    spend(60, 'play:overdraft'); // would be -30 without clamp, becomes 0
    earn(10, 'task:2');
    spend(5, 'play:tiny');
    expect(getBalance()).toBe(5);
  });
});

// ── Server-side balance sync ─────────────────────────────────────────────
//
// The launcher reads the authoritative balance via GET /users/{id}/balance
// after PATCH /tasks/{id} status=completed credits it server-side. Earn /
// spend used to mirror to POST /users/{id}/balance/adjust, but that endpoint
// is admin-only (per Alexey, 2026-05-19) and the call was removed — these
// tests pin that the launcher never reaches for it again.

describe('ledger earn/spend do not call any server-mutation API', () => {
  it('earn() makes no network calls — adjust is admin-only', async () => {
    const getUserBalance = vi.fn(async () => ({ balance: 0 }));
    configureBalanceSync({
      api: { getUserBalance },
      getUserId: () => 'user-A',
      isEnabled: () => true,
    });

    earn(3600, 'task:abc');
    // Let any stray microtasks settle so an accidental fire-and-forget
    // would show up before the assertion.
    await new Promise((r) => setImmediate(r));
    expect(getUserBalance).not.toHaveBeenCalled();
    expect(getBalance()).toBe(3600);
  });

  it('spend() makes no network calls', async () => {
    const getUserBalance = vi.fn(async () => ({ balance: 0 }));
    configureBalanceSync({
      api: { getUserBalance },
      getUserId: () => 'user-A',
      isEnabled: () => true,
    });

    earn(500, 'task:fund');
    spend(150, 'play:civ5');
    await new Promise((r) => setImmediate(r));
    expect(getUserBalance).not.toHaveBeenCalled();
    expect(getBalance()).toBe(350);
  });
});

describe('ledger.getServerBalance', () => {
  it('reads via api.getUserBalance and caches the result', async () => {
    const getUserBalance = vi.fn(async () => ({ balance: 4242 }));
    const onServerBalance = vi.fn();
    configureBalanceSync({
      api: { getUserBalance },
      getUserId: () => 'user-A',
      isEnabled: () => true,
      onServerBalance,
    });

    expect(await getServerBalance()).toBe(4242);
    expect(getUserBalance).toHaveBeenCalledTimes(1);
    expect(onServerBalance).toHaveBeenCalledWith(4242);

    // Second call within the TTL window must hit the cache, not the network.
    expect(await getServerBalance()).toBe(4242);
    expect(getUserBalance).toHaveBeenCalledTimes(1);
  });

  it('bypasses cache when called with { force: true }', async () => {
    const getUserBalance = vi
      .fn<() => Promise<{ balance: number }>>()
      .mockResolvedValueOnce({ balance: 100 })
      .mockResolvedValueOnce({ balance: 9999 });
    configureBalanceSync({
      api: { getUserBalance },
      getUserId: () => 'user-A',
      isEnabled: () => true,
    });

    expect(await getServerBalance()).toBe(100);
    // Without force, would return cached 100. With force, hits the network
    // again — this is the post-PATCH /tasks reconcile codepath.
    expect(await getServerBalance({ force: true })).toBe(9999);
    expect(getUserBalance).toHaveBeenCalledTimes(2);
  });

  it('returns null when sync is disabled or no user', async () => {
    const getUserBalance = vi.fn(async () => ({ balance: 0 }));
    configureBalanceSync({
      api: { getUserBalance },
      getUserId: () => 'user-A',
      isEnabled: () => false,
    });
    expect(await getServerBalance()).toBeNull();

    configureBalanceSync({
      api: { getUserBalance },
      getUserId: () => null,
      isEnabled: () => true,
    });
    expect(await getServerBalance()).toBeNull();
    expect(getUserBalance).not.toHaveBeenCalled();
  });
});

describe('ledger.removeInstall', () => {
  beforeEach(() => {
    // clearUserTables() intentionally leaves `installs` alone (an install
    // survives sign-out / sign-back-in for the same player). For these
    // tests we want a known-empty table.
    for (const row of listInstalls()) removeInstall(row.appid);
  });

  it('deletes the install row for the given appid, leaving others intact', () => {
    upsertInstall(413150, 'Stardew Valley', 'installed', '/games/413150');
    upsertInstall(72850, 'Skyrim', 'installed', '/games/72850');
    expect(getInstall(413150)).toBeDefined();
    expect(getInstall(72850)).toBeDefined();

    removeInstall(413150);

    expect(getInstall(413150)).toBeUndefined();
    expect(getInstall(72850)).toBeDefined();
    expect(listInstalls()).toHaveLength(1);
  });

  it('is a no-op for an appid with no install row', () => {
    upsertInstall(413150, 'Stardew Valley', 'installed', '/games/413150');
    expect(() => removeInstall(999999)).not.toThrow();
    expect(getInstall(413150)).toBeDefined();
  });
});

describe('ledger.reconcileWithServer', () => {
  it('inserts an adjust row so getBalance() matches the authoritative server value', () => {
    earn(100, 'task:local-only');
    expect(getBalance()).toBe(100);
    // Server thinks balance is 500 — local must catch up to it. Inserts
    // adjust(+400) so the sum becomes 500.
    reconcileWithServer(500);
    expect(getBalance()).toBe(500);
  });

  it('inserts a negative adjust row when server balance is lower than local', () => {
    earn(1000, 'task:over-counted');
    reconcileWithServer(200);
    // adjust(-800) makes the sum 200; the sum is clamped at 0 by
    // getBalance, but here we're well above zero.
    expect(getBalance()).toBe(200);
  });

  it('no-ops when local already matches', () => {
    earn(300, 'task:exact');
    reconcileWithServer(300);
    // No new adjust row introduced — exactly one earn row in the ledger.
    // (Pinning this so reconcile doesn't pile up zero-delta rows on repeated
    // sign-ins.)
    expect(getBalance()).toBe(300);
  });
});
