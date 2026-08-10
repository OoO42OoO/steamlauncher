/**
 * Pure-async tests for the email-auth-codes Steam Guard fallback in
 * downloader.ts. We import only `pollEmailAuthCode` — the spawn/IPC
 * surface stays out of scope. The `electron`, `paths`, `settings`,
 * `vault`, and `ledger` imports are stubbed because they reach into
 * Electron's `app` at module load time and would otherwise blow up
 * under Vitest's bare-Node runner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    setName: () => {},
    getPath: () => '/tmp/steam-client-test',
    requestSingleInstanceLock: () => true,
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));
vi.mock('electron-log/main.js', () => ({
  default: {
    info: () => {},
    warn: () => {},
    error: () => {},
    transports: { file: { resolvePathFn: null } },
  },
}));
vi.mock('./paths', () => ({
  paths: { cache: '/tmp/cache', authToken: '/tmp/api-token' },
  lockFileMode: () => {},
  resolveDepotDownloaderPath: () => '/usr/bin/true',
}));
vi.mock('./settings', () => ({ getInstallRoot: () => '/tmp/installs' }));
vi.mock('./ledger', () => ({ upsertInstall: () => {} }));
vi.mock('./vault', () => ({ withAccount: async () => {} }));

import {
  pollEmailAuthCode,
  type EmailAuthCodesFetcher,
  type EmailGuardPollOptions,
} from './downloader';
import { ApiError } from './api/client';

function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function makeOpts(
  overrides: Partial<EmailGuardPollOptions> & {
    fetcher: EmailAuthCodesFetcher;
  }
): EmailGuardPollOptions {
  return {
    accountId: 'acc_test',
    appid: 1,
    sleep: () => Promise.resolve(),
    now: () => Date.parse('2026-05-04T00:00:00Z'),
    intervalMs: 50,
    totalTimeoutMs: 1000,
    graceMs: 10_000,
    limit: 5,
    usedCodes: new Set<string>(),
    ...overrides,
  };
}

describe('pollEmailAuthCode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the freshest unused code on first hit', async () => {
    const t0 = Date.parse('2026-05-04T00:00:00Z');
    const fetcher = vi.fn(async () => ({
      account_id: 'acc_test',
      email_login_masked: 'a***@b',
      imap_host: 'mail',
      mailbox: 'INBOX',
      messages_scanned: 2,
      retrieved_at: isoFromMs(t0),
      codes: [
        {
          code: 'OLD11',
          subject: 'Old Steam',
          received_at: isoFromMs(t0 - 60_000), // older than cutoff
        },
        {
          code: 'NEW22',
          subject: 'Your Steam account: Access from new computer',
          received_at: isoFromMs(t0 - 1_000),
        },
      ],
    }));
    const res = await pollEmailAuthCode(makeOpts({ fetcher, now: () => t0 }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(res).toEqual({
      kind: 'code',
      code: 'NEW22',
      raw: expect.objectContaining({ code: 'NEW22' }),
    });
  });

  it('treats received_at older than cutoff (now - graceMs) as stale', async () => {
    const t0 = Date.parse('2026-05-04T00:00:00Z');
    const fetcher = vi.fn(async () => ({
      account_id: 'acc_test',
      email_login_masked: 'a***@b',
      imap_host: 'mail',
      mailbox: 'INBOX',
      messages_scanned: 1,
      retrieved_at: isoFromMs(t0),
      codes: [
        {
          code: 'STALE',
          subject: 'Steam',
          // 30s before now → outside the 10s grace.
          received_at: isoFromMs(t0 - 30_000),
        },
      ],
    }));
    const res = await pollEmailAuthCode(
      makeOpts({ fetcher, now: () => t0, graceMs: 10_000, totalTimeoutMs: 100 })
    );
    expect(res).toEqual({ kind: 'exhausted' });
  });

  it('skips codes already in usedCodes set', async () => {
    const t0 = Date.parse('2026-05-04T00:00:00Z');
    const fetcher = vi.fn(async () => ({
      account_id: 'acc_test',
      email_login_masked: 'a***@b',
      imap_host: 'mail',
      mailbox: 'INBOX',
      messages_scanned: 1,
      retrieved_at: isoFromMs(t0),
      codes: [
        {
          code: 'USED',
          subject: 'Steam',
          received_at: isoFromMs(t0 - 100),
        },
      ],
    }));
    const res = await pollEmailAuthCode(
      makeOpts({
        fetcher,
        now: () => t0,
        usedCodes: new Set(['USED']),
        totalTimeoutMs: 100,
      })
    );
    expect(res).toEqual({ kind: 'exhausted' });
  });

  it('returns 422 verdict immediately when fetcher throws ApiError(status=422)', async () => {
    const fetcher = vi.fn(async () => {
      throw new ApiError('invalid', 'no email creds', 422);
    });
    const res = await pollEmailAuthCode(makeOpts({ fetcher }));
    expect(res).toEqual({ kind: '422' });
    // Should not retry — exactly one fetch attempt before the abort.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error and returns code on later attempt', async () => {
    const t0 = Date.parse('2026-05-04T00:00:00Z');
    let nowMs = t0;
    const fetcher = vi
      .fn<EmailAuthCodesFetcher>()
      .mockImplementationOnce(async () => {
        throw new ApiError('service_unavailable', 'HTTP 503', 503);
      })
      .mockImplementationOnce(async () => ({
        account_id: 'acc_test',
        email_login_masked: 'a***@b',
        imap_host: 'mail',
        mailbox: 'INBOX',
        messages_scanned: 1,
        retrieved_at: isoFromMs(nowMs),
        codes: [
          {
            code: 'GOTIT',
            subject: 'Your Steam account: Access from new computer',
            received_at: isoFromMs(nowMs - 500),
          },
        ],
      }));
    const res = await pollEmailAuthCode(
      makeOpts({
        fetcher,
        now: () => nowMs,
        sleep: async (ms: number) => {
          nowMs += ms;
        },
        intervalMs: 100,
      })
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(res).toMatchObject({ kind: 'code', code: 'GOTIT' });
  });

  it('honours totalTimeoutMs and gives up with exhausted', async () => {
    const t0 = Date.parse('2026-05-04T00:00:00Z');
    let nowMs = t0;
    const fetcher = vi.fn(async () => ({
      account_id: 'acc_test',
      email_login_masked: 'a***@b',
      imap_host: 'mail',
      mailbox: 'INBOX',
      messages_scanned: 0,
      retrieved_at: isoFromMs(nowMs),
      codes: [],
    }));
    const res = await pollEmailAuthCode(
      makeOpts({
        fetcher,
        now: () => nowMs,
        sleep: async (ms: number) => {
          nowMs += ms;
        },
        totalTimeoutMs: 250,
        intervalMs: 100,
      })
    );
    expect(res).toEqual({ kind: 'exhausted' });
    // 0ms first call, +100ms (~100), +100ms (~200) — third call would be at
    // ~300ms and is past timeout, so we stop after 3 attempts at most.
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it('bails early when isExited returns true', async () => {
    let exited = false;
    const fetcher = vi.fn(async () => {
      exited = true;
      return {
        account_id: 'acc_test',
        email_login_masked: 'a***@b',
        imap_host: 'mail',
        mailbox: 'INBOX',
        messages_scanned: 0,
        retrieved_at: new Date().toISOString(),
        codes: [],
      };
    });
    const res = await pollEmailAuthCode(
      makeOpts({
        fetcher,
        isExited: () => exited,
        sleep: () => Promise.resolve(),
      })
    );
    expect(res).toEqual({ kind: 'exhausted' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('prefers "Access from new computer" subject over older Steam mail', async () => {
    const t0 = Date.parse('2026-05-04T00:00:00Z');
    const fetcher = vi.fn(async () => ({
      account_id: 'acc_test',
      email_login_masked: 'a***@b',
      imap_host: 'mail',
      mailbox: 'INBOX',
      messages_scanned: 2,
      retrieved_at: isoFromMs(t0),
      codes: [
        {
          code: 'NEWER',
          subject: 'Some other Steam mail',
          received_at: isoFromMs(t0 - 1_000),
        },
        {
          code: 'PREFERRED',
          subject: 'Your Steam account: Access from new computer',
          received_at: isoFromMs(t0 - 5_000),
        },
      ],
    }));
    const res = await pollEmailAuthCode(makeOpts({ fetcher, now: () => t0 }));
    expect(res).toMatchObject({ kind: 'code', code: 'PREFERRED' });
  });
});
