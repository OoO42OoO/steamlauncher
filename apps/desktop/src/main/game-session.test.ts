import { describe, it, expect, vi } from 'vitest';
import type { GameSessionRead } from '@steam-client/shared/api';

vi.mock('electron-log/main.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// ApiError comes from api/client, which pulls in `electron` + `./paths`; both
// touch Electron's `app` at import time and aren't available under bare Node.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}));
vi.mock('./paths', () => ({
  lockFileMode: () => {},
  paths: { authToken: '/tmp/auth-token-test' },
}));

import { checkGameSession } from './game-session';
import { ApiError } from './api/client';

const session = (over: Partial<GameSessionRead> = {}): GameSessionRead => ({
  user_id: 'u1',
  is_active: true,
  issued_at: null,
  expires_at: null,
  remaining_seconds: 6 * 3600,
  ...over,
});

describe('checkGameSession', () => {
  it('allows play when the server reports an active session', async () => {
    const fetchSession = vi.fn().mockResolvedValue(session());
    await expect(checkGameSession({ fetchSession })).resolves.toBe('ok');
  });

  it('gates play when the session is not active', async () => {
    const fetchSession = vi.fn().mockResolvedValue(
      session({ is_active: false, remaining_seconds: 0 })
    );
    await expect(checkGameSession({ fetchSession })).resolves.toBe('required');
  });

  it('asks the server every single time — no verdict is cached', async () => {
    const fetchSession = vi.fn().mockResolvedValue(session());
    const deps = { fetchSession };

    await expect(checkGameSession(deps)).resolves.toBe('ok');
    await expect(checkGameSession(deps)).resolves.toBe('ok');
    await expect(checkGameSession(deps)).resolves.toBe('ok');
    expect(fetchSession).toHaveBeenCalledTimes(3);
  });

  it('sees a session that lapsed since the last check', async () => {
    const fetchSession = vi
      .fn()
      .mockResolvedValueOnce(session())
      .mockResolvedValueOnce(session({ is_active: false, remaining_seconds: 0 }));
    const deps = { fetchSession };

    await expect(checkGameSession(deps)).resolves.toBe('ok');
    await expect(checkGameSession(deps)).resolves.toBe('required');
  });

  it('sees a session the bot granted since the last check', async () => {
    const fetchSession = vi
      .fn()
      .mockResolvedValueOnce(session({ is_active: false, remaining_seconds: 0 }))
      .mockResolvedValueOnce(session());
    const deps = { fetchSession };

    await expect(checkGameSession(deps)).resolves.toBe('required');
    await expect(checkGameSession(deps)).resolves.toBe('ok');
  });

  it('refuses when the server cannot be reached', async () => {
    // Fails CLOSED. An unreachable API is exactly the state an unentitled
    // client would like to be in, so "we could not ask" is not a pass.
    const fetchSession = vi
      .fn()
      .mockRejectedValue(new ApiError('service_unavailable', 'HTTP 503', 503));
    await expect(checkGameSession({ fetchSession })).resolves.toBe('unreachable');
  });

  it('refuses on a bare network error too', async () => {
    const fetchSession = vi.fn().mockRejectedValue(new Error('fetch failed'));
    await expect(checkGameSession({ fetchSession })).resolves.toBe('unreachable');
  });

  it('gates on an explicit game-session 403', async () => {
    // A 403 is an answer, not a failure to get one.
    const fetchSession = vi
      .fn()
      .mockRejectedValue(
        new ApiError('game_session_required', 'active game session is required', 403)
      );
    await expect(checkGameSession({ fetchSession })).resolves.toBe('required');
  });
});
