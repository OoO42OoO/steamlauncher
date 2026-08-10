/**
 * Remembers who is signed in, so closing the launcher doesn't cost a code.
 *
 * The Bearer itself is already persisted by the API client (`auth-token.bin`),
 * and since 2026-07 it does not expire — but nothing restored the *session*
 * from it, so `setSession({state:'signed_in'})` only ever ran inside the
 * redeem handler and every launch started at the code screen with a perfectly
 * good token sitting on disk.
 *
 * Restoring needs the user record as well as the token: the shell renders the
 * account id and the trust level, and asking the server for them would put a
 * network round trip — and a network *failure* — between the user and their
 * library. So the record is cached here, next to the token and encrypted the
 * same way, and refreshed from the server in the background once the window
 * is up.
 *
 * safeStorage only: the record is not a credential, but it names the account,
 * and the token beside it is already fail-closed on a missing keyring. Same
 * rule keeps the two files consistent — either both are readable or neither
 * is, and a half-restored session is worse than no restore.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { safeStorage } from 'electron';
import log from 'electron-log/main.js';
import { UserReadSchema, type UserRead } from '@steam-client/shared/api';
import { lockFileMode } from './paths';

/** Persist the signed-in user. Silently does nothing without a keyring. */
export function saveStoredUser(filePath: string, user: UserRead): void {
  if (!safeStorage.isEncryptionAvailable()) {
    log.warn('[session] safeStorage unavailable — session will not survive a restart');
    return;
  }
  try {
    writeFileSync(filePath, safeStorage.encryptString(JSON.stringify(user)));
    lockFileMode(filePath, 0o600);
  } catch (err) {
    log.warn('[session] failed to persist user:', (err as Error).message);
  }
}

/**
 * The last signed-in user, or null.
 *
 * A record that is genuinely unusable — truncated, or a shape the schema no
 * longer accepts — is deleted rather than nursed: the cost is one redeem, and
 * a stale identity would be attached to a live token. A missing keyring is
 * NOT that: it says nothing about the file, and deleting on it is precisely
 * how the Bearer next door used to be lost on every boot.
 */
export function loadStoredUser(filePath: string): UserRead | null {
  try {
    if (!existsSync(filePath)) return null;
    if (!safeStorage.isEncryptionAvailable()) {
      // Kept, not deleted — see the same note in api.ts loadToken. A keyring
      // that isn't up yet says nothing about whether the file is good.
      return null;
    }
    const parsed = UserReadSchema.safeParse(
      JSON.parse(safeStorage.decryptString(readFileSync(filePath)))
    );
    if (!parsed.success) {
      unlinkSync(filePath);
      return null;
    }
    return parsed.data;
  } catch (err) {
    log.warn('[session] stored user unreadable:', (err as Error).message);
    try {
      unlinkSync(filePath);
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** Forget the signed-in user. Paired with the client dropping its Bearer. */
export function clearStoredUser(filePath: string): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch (err) {
    log.warn('[session] failed to clear stored user:', (err as Error).message);
  }
}
