import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// api.ts pulls in `electron` (safeStorage) and `../paths`. Both modules
// reach into Electron's `app.getPath(...)` at import time, which obviously
// isn't available under bare Node. Stub them out before the SUT loads.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));
vi.mock('../paths', () => ({
  lockFileMode: () => {},
  paths: { authToken: '/tmp/auth-token-test' },
}));

import { ApiClient, ApiError } from './client';

type FetchArgs = [string | URL, RequestInit | undefined];

function makeResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('ApiClient 401 handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: ApiClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new ApiClient({
      baseUrl: 'https://api.test',
      timeoutMs: 1000,
      tokenFilePath: '/tmp/auth-token-test',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hasToken() is false on a fresh client (no persisted token)', () => {
    expect(client.hasToken()).toBe(false);
  });

  it('redeem() accepts a token and subsequent calls send Bearer header', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        code: 'C',
        status: 'expired',
        expired_at: new Date().toISOString(),
        user: { id: 'u1', email: 'a@b.co', trust_level: 50, balance: 0 },
        access_token: 'tok-123',
        token_type: 'bearer',
        access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      })
    );
    await client.redeem('CODE');
    expect(client.hasToken()).toBe(true);

    // Next protected call should carry the bearer header.
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { id: 'u1', email: 'a@b.co', trust_level: 50, balance: 0 })
    );
    await client.getUser('u1');

    const [, init] = fetchMock.mock.calls[1] as FetchArgs;
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
  });

  it('wipes the bearer token on a 401 from a protected call', async () => {
    // First, prime the client with a token via redeem().
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        code: 'C',
        status: 'expired',
        expired_at: new Date().toISOString(),
        user: { id: 'u1', email: 'a@b.co', trust_level: 50, balance: 0 },
        access_token: 'tok-123',
        token_type: 'bearer',
        access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      })
    );
    await client.redeem('CODE');
    expect(client.hasToken()).toBe(true);

    // 401 on a protected GET → token wipe.
    fetchMock.mockResolvedValueOnce(makeResponse(401, { error: 'unauthorized' }));
    await expect(client.getUser('u1')).rejects.toBeInstanceOf(ApiError);

    expect(client.hasToken()).toBe(false);

    // Subsequent protected call must not carry a stale Bearer. The client is
    // fail-closed and will reject locally with ApiError('service_unavailable',
    // 'no bearer token') BEFORE issuing a fetch — verify no extra fetch calls
    // and no fetched URL has Authorization.
    await expect(client.getUser('u1')).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2); // redeem + the 401 GET, nothing else
  });

  it('does NOT wipe the token on a non-401 error (control: 500)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        code: 'C',
        status: 'expired',
        expired_at: new Date().toISOString(),
        user: { id: 'u1', email: 'a@b.co', trust_level: 50, balance: 0 },
        access_token: 'tok-500',
        token_type: 'bearer',
        access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      })
    );
    await client.redeem('CODE');
    expect(client.hasToken()).toBe(true);

    fetchMock.mockResolvedValueOnce(makeResponse(500, { error: 'oops' }));
    await expect(client.getUser('u1')).rejects.toBeInstanceOf(ApiError);

    // Token survives — server failure is not an auth signal.
    expect(client.hasToken()).toBe(true);

    // Next call should still include the bearer.
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, { id: 'u1', email: 'a@b.co', trust_level: 50, balance: 0 })
    );
    await client.getUser('u1');
    const [, init] = fetchMock.mock.calls[2] as FetchArgs;
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-500');
  });

  it('does NOT wipe the token on a 403 (matches current code: only 401 wipes)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        code: 'C',
        status: 'expired',
        expired_at: new Date().toISOString(),
        user: { id: 'u1', email: 'a@b.co', trust_level: 50, balance: 0 },
        access_token: 'tok-403',
        token_type: 'bearer',
        access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      })
    );
    await client.redeem('CODE');

    fetchMock.mockResolvedValueOnce(makeResponse(403, { error: 'forbidden' }));
    await expect(client.getUser('u1')).rejects.toBeInstanceOf(ApiError);
    // Documented: server.ts wipes on 401 specifically. 403 is "auth rejected"
    // for a different reason (perm/scope) and currently keeps the token.
    expect(client.hasToken()).toBe(true);
  });

  it('emits "auth:expired" when 401 wipes the token', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        code: 'C',
        status: 'expired',
        expired_at: new Date().toISOString(),
        user: { id: 'u1', email: 'a@b.co', trust_level: 50, balance: 0 },
        access_token: 'tok-evt',
        token_type: 'bearer',
        access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      })
    );
    await client.redeem('CODE');

    const expired = vi.fn();
    client.on('auth:expired', expired);

    fetchMock.mockResolvedValueOnce(makeResponse(401, {}));
    await expect(client.getUser('u1')).rejects.toBeInstanceOf(ApiError);

    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('logout() clears the token without issuing a network call', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        code: 'C',
        status: 'expired',
        expired_at: new Date().toISOString(),
        user: { id: 'u1', email: 'a@b.co', trust_level: 50, balance: 0 },
        access_token: 'tok-bye',
        token_type: 'bearer',
        access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      })
    );
    await client.redeem('CODE');
    expect(client.hasToken()).toBe(true);

    client.logout();
    expect(client.hasToken()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the redeem
  });
});

describe('ApiClient.getEmailAuthCodes', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: ApiClient;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    client = new ApiClient({
      baseUrl: 'https://api.test',
      timeoutMs: 1000,
      tokenFilePath: '/tmp/auth-token-test',
    });
    // Prime token via redeem.
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        code: 'C',
        status: 'expired',
        expired_at: new Date().toISOString(),
        user: { id: 'u1', email: 'a@b.co', trust_level: 50, balance: 0 },
        access_token: 'tok-eac',
        token_type: 'bearer',
        access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      })
    );
    await client.redeem('CODE');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('builds POST URL with user_id and limit query params', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        account_id: 'acc_1',
        email_login_masked: 'ar***@example.invalid',
        imap_host: 'mail.example.invalid',
        mailbox: 'INBOX',
        messages_scanned: 0,
        retrieved_at: new Date().toISOString(),
        codes: [],
      })
    );
    const res = await client.getEmailAuthCodes('acc_1', { userId: 'u1', limit: 5 });
    expect(res.codes).toEqual([]);
    expect(res.email_login_masked).toBe('ar***@example.invalid');

    const [url, init] = fetchMock.mock.calls[1] as FetchArgs;
    expect(String(url)).toBe(
      'https://api.test/accounts/acc_1/email-auth-codes?user_id=u1&limit=5'
    );
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-eac');
  });

  it('parses 200 with codes and tolerates extra fields (passthrough)', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        account_id: 'acc_4bd5639f0adf',
        email_login_masked: 'ar***@example.invalid',
        imap_host: 'mail.example.invalid',
        mailbox: 'INBOX',
        messages_scanned: 2,
        retrieved_at: '2026-05-03T20:36:57Z',
        codes: [
          {
            code: 'H6X8K',
            subject: 'Your Steam account: Access from new computer',
            from_email: 'noreply@steampowered.com',
            received_at: '2026-05-03T20:36:57Z',
            // Extra unknown field — must not fail parsing.
            extra: 'ignored',
          },
        ],
        // Top-level extra field — must not fail parsing.
        future_field: { foo: 'bar' },
      })
    );
    const res = await client.getEmailAuthCodes('acc_4bd5639f0adf');
    expect(res.codes).toHaveLength(1);
    const first = res.codes[0]!;
    expect(first.code).toBe('H6X8K');
    expect(first.subject).toContain('Access from new computer');
  });

  it('throws ApiError with status=422 on "no email credentials"', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(422, { detail: 'Account does not have email credentials' })
    );
    await expect(client.getEmailAuthCodes('acc_nope')).rejects.toMatchObject({
      name: 'ApiError',
      status: 422,
    });
    // Token must NOT be wiped — 422 isn't an auth signal.
    expect(client.hasToken()).toBe(true);
  });

  it('omits query string when no opts provided', async () => {
    fetchMock.mockResolvedValueOnce(
      makeResponse(200, {
        account_id: 'acc_1',
        email_login_masked: 'a***@b.co',
        imap_host: 'mail.example.com',
        mailbox: 'INBOX',
        messages_scanned: 0,
        retrieved_at: new Date().toISOString(),
        codes: [],
      })
    );
    await client.getEmailAuthCodes('acc_1');
    const [url] = fetchMock.mock.calls[1] as FetchArgs;
    expect(String(url)).toBe('https://api.test/accounts/acc_1/email-auth-codes');
  });
});
