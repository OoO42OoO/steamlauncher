import { describe, expect, it } from 'vitest';
import { configureVault, withAccount } from './vault';

const fakeAccount = () => ({
  id: 'acc-1',
  game_name: 'Test',
  appid: 1,
  min_trust_level: 0,
  guard: false,
  login: 'user',
  password: 'pw',
  email_login: 'e@x',
  email_password: 'ep',
  steam_mafile_plain: null,
});

describe('withAccount', () => {
  it('invokes fn with the fetched account and returns its result', async () => {
    configureVault(async () => fakeAccount() as never);
    const out = await withAccount('acc-1', async (creds) => creds.login);
    expect(out).toBe('user');
  });

  it('rejects a second call with a different id while one is in flight', async () => {
    let release: () => void = () => {};
    configureVault(async () => fakeAccount() as never);
    const slow = withAccount('acc-1', async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return 'ok';
    });
    // Let the first call reach its await (reserve the inFlight slot).
    await Promise.resolve();
    await expect(
      withAccount('acc-2', async () => 'x')
    ).rejects.toThrow(/another account session/);
    release();
    await slow;
  });

  it('serialises two concurrent calls with the same id (no aliasing)', async () => {
    configureVault(async () => fakeAccount() as never);
    let firstReleased = false;
    const first = withAccount('acc-1', async () => {
      await new Promise<void>((r) => setTimeout(r, 20));
      firstReleased = true;
      return 'first';
    });
    const second = withAccount('acc-1', async () => {
      // If serialisation works, `firstReleased` must be true by the time
      // this fn runs (i.e. the second call waited for the first).
      return firstReleased ? 'second-after' : 'second-before';
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe('first');
    expect(b).toBe('second-after');
  });
});
