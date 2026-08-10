import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `electron` import isn't actually used by server-token.ts, but the
// native-messaging-install module reads `app.getAppPath` / `process.resourcesPath`,
// so stub the surface those touch.
vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getAppPath: () => '/tmp/app',
    isPackaged: false,
    setName: () => {},
  },
}));

import { buildManifest, HOST_NAME } from './native-messaging-install';
import {
  getServerToken,
  ipcSocketPath,
  rotateServerToken,
} from './server-token';

describe('server-token: getServerToken', () => {
  it('returns a 64-char lowercase hex string (32 bytes random)', () => {
    const t = getServerToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable on repeat calls within a process', () => {
    const a = getServerToken();
    const b = getServerToken();
    expect(a).toBe(b);
  });

  it('rotateServerToken returns a different value', () => {
    const before = getServerToken();
    const after = rotateServerToken();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('server-token: ipcSocketPath', () => {
  // We can't truly change `process.platform` per-test cleanly without
  // module reload, but we can sanity-check the current platform's shape.
  it('returns a path string', () => {
    const p = ipcSocketPath();
    expect(typeof p).toBe('string');
    expect(p.length).toBeGreaterThan(0);
  });

  it('matches the platform pattern', () => {
    const p = ipcSocketPath();
    if (process.platform === 'win32') {
      expect(p.startsWith('\\\\.\\pipe\\steam-client.token.')).toBe(true);
    } else {
      // POSIX: ends in steam-client.token.<user>.sock under tmpdir
      expect(p).toMatch(/steam-client\.token\.[^/]+\.sock$/);
    }
  });
});

describe('native-messaging: buildManifest', () => {
  const launcher = '/path/to/host.sh';

  it('uses the agreed host name', () => {
    const m = buildManifest(launcher, ['abcdef']);
    expect(m.name).toBe(HOST_NAME);
    expect(HOST_NAME).toBe('com.steam_client.token');
  });

  it('uses stdio transport (Chrome NM requirement)', () => {
    const m = buildManifest(launcher, []);
    expect(m.type).toBe('stdio');
  });

  it('formats allowed_origins as chrome-extension:// URLs with trailing slash', () => {
    const m = buildManifest(launcher, ['abcdefghijklmnop', 'qrstuvwxyzabcdef']);
    expect(m.allowed_origins).toEqual([
      'chrome-extension://abcdefghijklmnop/',
      'chrome-extension://qrstuvwxyzabcdef/',
    ]);
  });

  it('preserves the launcher path verbatim', () => {
    const m = buildManifest('/weird path/with spaces.sh', ['x']);
    expect(m.path).toBe('/weird path/with spaces.sh');
  });

  it('produces an empty allowed_origins when no IDs are passed', () => {
    const m = buildManifest(launcher, []);
    expect(m.allowed_origins).toEqual([]);
  });
});

// Length-prefixed JSON parser mirroring the host.js logic. We re-implement
// the read loop in-process and run fixtures through it. host.js itself is
// CJS and bound to process.stdin, so we test its protocol here rather than
// import from it directly.
function parseLengthPrefixed(buf: Buffer): unknown {
  if (buf.length < 4) throw new Error('truncated header');
  const bodyLen = buf.readUInt32LE(0);
  const body = buf.slice(4, 4 + bodyLen);
  if (body.length < bodyLen) throw new Error('truncated body');
  return JSON.parse(body.toString('utf8'));
}

function frame(obj: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

describe('native messaging: length-prefixed protocol', () => {
  it('round-trips a small payload', () => {
    const obj = { cmd: 'get_token' };
    const buf = frame(obj);
    // 4-byte LE header + JSON body
    expect(buf.length).toBe(4 + JSON.stringify(obj).length);
    expect(buf.readUInt32LE(0)).toBe(JSON.stringify(obj).length);
    expect(parseLengthPrefixed(buf)).toEqual(obj);
  });

  it('round-trips a token response', () => {
    const obj = { ok: true, token: 'a'.repeat(64) };
    expect(parseLengthPrefixed(frame(obj))).toEqual(obj);
  });

  it('throws on a header that says more bytes than were delivered', () => {
    const fake = Buffer.alloc(8);
    fake.writeUInt32LE(100, 0);
    expect(() => parseLengthPrefixed(fake)).toThrow();
  });
});

beforeEach(() => {
  // Clear module-private token between tests so the rotate/stable tests
  // don't bleed into each other.
  rotateServerToken();
});

afterEach(() => {
  vi.restoreAllMocks();
});
