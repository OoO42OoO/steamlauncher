import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { request } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { WebSocket } from 'ws';

// server.ts imports `./ledger` (which pulls in better-sqlite3 via paths).
// We don't need a real DB for the auth tests — stub ledger + paths so the
// SUT loads without hitting native bindings.
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', setName: () => {}, isPackaged: false },
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
vi.mock('./ledger', () => ({
  initLedger: () => undefined,
  addSiteTime: vi.fn(() => true),
  getBalance: vi.fn(() => 1234),
}));

import { startServer, stopServer } from './server';
import { addSiteTime } from './ledger';

const TOKEN = 'test-token-secret';

// Pick an ephemeral port. We listen on 0 then read the bound port back from
// the underlying http.Server. To avoid racing on bind, we patch the server
// after startServer kicks off `listen(...)` and read the address once it's
// up.
function getServerPort(): Promise<number> {
  // The `httpServer` is module-private. We instead grab a free port up-front
  // via a transient probe (bind to 0, read the assigned port, close).
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('listening', () => {
      const addr = probe.address() as AddressInfo;
      probe.close(() => resolve(addr.port));
    });
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1');
  });
}

function httpRequest(opts: {
  port: number;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method,
        path: opts.path,
        headers: {
          'Content-Type': 'application/json',
          ...(opts.headers || {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

let port: number;

beforeAll(async () => {
  port = await getServerPort();
  startServer({ port, token: TOKEN, version: '1.0.0' });
  // express.listen is async; give it a tick to actually accept connections.
  await new Promise((r) => setTimeout(r, 50));
});

afterEach(() => {
  vi.mocked(addSiteTime).mockClear();
});

describe('server: /site-time auth', () => {
  const validBody = JSON.stringify({ domain: 'example.com', seconds: 60 });

  it('returns 401 when Authorization header is missing', async () => {
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/site-time',
      body: validBody,
    });
    expect(res.status).toBe(401);
    expect(addSiteTime).not.toHaveBeenCalled();
  });

  it('returns 401 with a wrong Bearer token', async () => {
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/site-time',
      headers: { Authorization: 'Bearer not-the-token' },
      body: validBody,
    });
    expect(res.status).toBe(401);
    expect(addSiteTime).not.toHaveBeenCalled();
  });

  it('returns 401 if the header is present but does not start with Bearer', async () => {
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/site-time',
      headers: { Authorization: TOKEN }, // no "Bearer " prefix
      body: validBody,
    });
    expect(res.status).toBe(401);
    expect(addSiteTime).not.toHaveBeenCalled();
  });

  it('runs the handler with the correct token', async () => {
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/site-time',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: validBody,
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(addSiteTime).toHaveBeenCalledWith('example.com', 60);
  });

  it('returns 400 on a malformed body even with valid auth', async () => {
    const res = await httpRequest({
      port,
      method: 'POST',
      path: '/site-time',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ domain: 'has spaces.com', seconds: 60 }),
    });
    expect(res.status).toBe(400);
    expect(addSiteTime).not.toHaveBeenCalled();
  });
});

describe('server: /health (public)', () => {
  it('responds 200 without auth', async () => {
    const res = await httpRequest({ port, method: 'GET', path: '/health' });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.version).toBe('1.0.0');
  });
});

describe('server: WS Origin/token enforcement', () => {
  it('rejects WS upgrade without an extension Origin', async () => {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timeout — close never fired')),
        2000
      );
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, {
        headers: { Origin: 'https://evil.example' },
      });
      // Note: ws calls handleUpgrade *before* invoking the connection callback.
      // server.ts close()s with 1008 inside that callback, which means the
      // client may briefly observe `open` before the close arrives. We assert
      // on the eventual close code regardless.
      ws.on('close', (code) => {
        clearTimeout(timer);
        expect(code).toBe(1008);
        resolve();
      });
      ws.on('error', () => {});
    });
  });

  it('rejects WS upgrade from a chrome-extension origin with the wrong token', async () => {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timeout — close never fired')),
        2000
      );
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong`, {
        headers: { Origin: 'chrome-extension://abc123' },
      });
      ws.on('close', (code) => {
        clearTimeout(timer);
        expect(code).toBe(1008);
        resolve();
      });
      ws.on('error', () => {});
    });
  });

  it('accepts WS upgrade from chrome-extension Origin with the right token', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, {
        headers: { Origin: 'chrome-extension://abc123' },
      });
      let opened = false;
      ws.on('open', () => {
        opened = true;
      });
      ws.on('message', (data) => {
        if (!opened) return;
        const msg = JSON.parse(data.toString());
        // First push is the current balance — proves the handler ran.
        expect(msg).toEqual({ type: 'balance', seconds: 1234 });
        ws.close();
        resolve();
      });
      ws.on('error', (err) => reject(err));
    });
  });

  it('accepts moz-extension Origin too', async () => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`, {
        headers: { Origin: 'moz-extension://abc123' },
      });
      ws.on('open', () => {
        ws.close();
        resolve();
      });
      ws.on('close', (code) => {
        if (code === 1008) reject(new Error('rejected unexpectedly'));
      });
      ws.on('error', (err) => reject(err));
    });
  });
});

// Tear the server down at the end of the file so other test files (or a
// follow-up test run) can rebind the port.
afterAll(() => {
  stopServer();
});
