/**
 * Verifies that openDbWithRecovery survives a mid-recovery EPERM on rmSync.
 * Scenario: SQLite refuses to open the existing file, recovery tries to
 * delete the WAL triplet, and one of the rmSync calls throws EPERM (Windows
 * antivirus / stale handle). The function must log + continue and finally
 * succeed at re-opening.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const rmSyncMock = vi.fn();
const constructorCalls: string[] = [];

class FakeDb {
  pragma = vi.fn();
  exec = vi.fn();
  prepare = vi.fn(() => ({
    run: () => ({}),
    get: () => undefined,
    all: () => [],
  }));
  transaction = vi.fn((fn: () => unknown) => () => fn());
  close = vi.fn();
}

let throwOnFirstOpen = true;
const dbConstructor = vi.fn((p: string) => {
  constructorCalls.push(p);
  if (throwOnFirstOpen) {
    throwOnFirstOpen = false;
    const err = new Error('unable to open database file') as Error & {
      code?: string;
    };
    err.code = 'SQLITE_CANTOPEN';
    throw err;
  }
  return new FakeDb();
});

vi.mock('better-sqlite3', () => ({ default: dbConstructor }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: (...args: unknown[]) => rmSyncMock(...args),
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', setName: () => {}, isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));

vi.mock('./paths', () => ({
  paths: { db: '/tmp/test-ledger.db' },
  lockFileMode: () => {},
  ensurePaths: () => {},
}));

afterEach(() => {
  vi.resetModules();
  rmSyncMock.mockReset();
  constructorCalls.length = 0;
  throwOnFirstOpen = true;
  dbConstructor.mockClear();
});

describe('ledger.openDbWithRecovery — permission resilience', () => {
  it('recovers when rmSync of the WAL triplet throws EPERM', async () => {
    // First rmSync (the .db itself) throws EPERM; the -shm and -wal calls
    // succeed. Recovery must swallow the EPERM and continue.
    let calls = 0;
    rmSyncMock.mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        const err = new Error('operation not permitted') as Error & {
          code?: string;
        };
        err.code = 'EPERM';
        throw err;
      }
    });

    const mod = await import('./ledger');
    expect(() => mod.initLedger()).not.toThrow();

    // Both Database constructor calls should have been attempted (first
    // throws, second succeeds after wipe attempt).
    expect(constructorCalls).toEqual(['/tmp/test-ledger.db', '/tmp/test-ledger.db']);
    // All three suffixes were attempted despite the first one throwing.
    expect(rmSyncMock).toHaveBeenCalledTimes(3);
    mod.closeLedger();
  });

  it('recovers when every rmSync call throws (most-pessimistic case)', async () => {
    rmSyncMock.mockImplementation(() => {
      const err = new Error('operation not permitted') as Error & {
        code?: string;
      };
      err.code = 'EPERM';
      throw err;
    });

    const mod = await import('./ledger');
    // Even with all three rmSync calls failing, the second Database open
    // attempt is still reached. Our fake constructor succeeds the second
    // time, mirroring real-world transient locking that clears.
    expect(() => mod.initLedger()).not.toThrow();
    expect(rmSyncMock).toHaveBeenCalledTimes(3);
    mod.closeLedger();
  });
});
