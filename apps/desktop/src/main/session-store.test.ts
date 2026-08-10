/**
 * The launcher used to ask for a code on every start even though the Bearer
 * was already on disk and does not expire — nothing ever restored the session
 * from it. These tests cover the half that was missing: remembering who is
 * signed in, and refusing to half-remember.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UserRead } from '@steam-client/shared/api';

const keyring = vi.hoisted(() => ({ available: true }));
const encryptSpy = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => keyring.available,
    // Reversible stand-in for the OS keyring: the tests care that the bytes
    // on disk are not the plaintext and that a round trip survives.
    encryptString: (s: string) => {
      encryptSpy(s);
      return Buffer.concat([Buffer.from('enc:'), Buffer.from(s, 'utf8')]);
    },
    decryptString: (b: Buffer) => {
      const raw = Buffer.from(b);
      if (!raw.subarray(0, 4).equals(Buffer.from('enc:'))) {
        throw new Error('bad ciphertext');
      }
      return raw.subarray(4).toString('utf8');
    },
  },
}));
vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./paths', () => ({ lockFileMode: () => {}, paths: {} }));

import { clearStoredUser, loadStoredUser, saveStoredUser } from './session-store';

const user = (over: Partial<UserRead> = {}): UserRead => ({
  id: 'u-42',
  email: null,
  trust_level: 2,
  balance: 0,
  ...over,
});

let dir: string;
let file: string;

beforeEach(() => {
  keyring.available = true;
  encryptSpy.mockClear();
  dir = mkdtempSync(join(tmpdir(), 'session-store-'));
  file = join(dir, 'auth-user.bin');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('session-store', () => {
  it('round-trips the signed-in user', () => {
    saveStoredUser(file, user());
    expect(loadStoredUser(file)).toEqual(user());
  });

  it('goes through safeStorage rather than writing the record itself', () => {
    saveStoredUser(file, user({ id: 'secret-account' }));
    expect(encryptSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(encryptSpy.mock.calls[0]![0] as string).id).toBe('secret-account');
    // Whatever landed on disk is what safeStorage produced, not our JSON.
    expect(readFileSync(file).equals(Buffer.from(encryptSpy.mock.calls[0]![0] as string)))
      .toBe(false);
  });

  it('answers null when nothing has been stored', () => {
    expect(loadStoredUser(file)).toBeNull();
  });

  it('keeps a restart from re-asking for a code', () => {
    // The whole point: save, "restart", still know who it is.
    saveStoredUser(file, user({ id: 'u-99', trust_level: 5 }));
    const restored = loadStoredUser(file);
    expect(restored?.id).toBe('u-99');
    expect(restored?.trust_level).toBe(5);
  });

  it('writes nothing at all without a keyring', () => {
    keyring.available = false;
    saveStoredUser(file, user());
    expect(existsSync(file)).toBe(false);
  });

  it('keeps the record when the keyring is merely not up yet', () => {
    // The bug this guards against: safeStorage answers false before the app
    // is ready, and treating that as "corrupt" deleted the Bearer next door
    // on every single boot — which is why signing in never survived a
    // restart. Unavailable means "ask again later", not "throw it away".
    saveStoredUser(file, user());
    keyring.available = false;
    expect(loadStoredUser(file)).toBeNull();
    expect(existsSync(file)).toBe(true);

    keyring.available = true;
    expect(loadStoredUser(file)).toEqual(user());
  });

  it('drops a corrupt record', () => {
    writeFileSync(file, Buffer.from('not ciphertext'));
    expect(loadStoredUser(file)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('drops a record the schema no longer accepts', () => {
    // A shape from an older build — better one redeem than a stale identity
    // attached to a live token.
    writeFileSync(
      file,
      Buffer.concat([Buffer.from('enc:'), Buffer.from(JSON.stringify({ id: 'u-1' }))])
    );
    expect(loadStoredUser(file)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('forgets on request, and forgetting twice is fine', () => {
    saveStoredUser(file, user());
    clearStoredUser(file);
    expect(existsSync(file)).toBe(false);
    expect(() => clearStoredUser(file)).not.toThrow();
  });
});
