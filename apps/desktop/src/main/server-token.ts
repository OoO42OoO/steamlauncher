/**
 * Ephemeral server token + IPC delivery channel.
 *
 * Replaces the historical hardcoded `SERVER_TOKEN = 'dev-token-change-me'`
 * with a fresh 32-byte hex token regenerated at every app start. The token
 * lives in RAM only — no on-disk persistence.
 *
 * Browser extensions cannot read RAM directly, so we expose a tiny IPC
 * server (Unix socket on POSIX, Named Pipe on Windows). A standalone
 * Native Messaging host (apps/desktop/native-messaging-host/host.js) is
 * launched on demand by Chrome and proxies the token to the extension.
 *
 * The IPC channel is single-shot: any incoming bytes trigger one JSON
 * response then the server end-closes. There is no command vocabulary —
 * if anything connects, it gets the current token. POSIX permissions
 * (0600) restrict the socket to the owning user.
 */
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import log from 'electron-log/main.js';

let currentToken: string | null = null;
let ipcServer: net.Server | null = null;

/**
 * Get the current ephemeral token, generating one on first call. The token
 * is cryptographically random (32 bytes → 64 hex chars).
 */
export function getServerToken(): string {
  if (!currentToken) currentToken = crypto.randomBytes(32).toString('hex');
  return currentToken;
}

/** Force-rotate the token. Used by tests; not invoked at runtime. */
export function rotateServerToken(): string {
  currentToken = crypto.randomBytes(32).toString('hex');
  return currentToken;
}

/**
 * Deterministic per-user, per-OS path of the IPC channel. The native
 * messaging host computes the same path (see host.js) and connects.
 *
 * - POSIX: `<tmp>/steam-client.token.<username>.sock` — tmp is per-user
 *   on most distros, plus we chmod 0600 after listen for defence in depth.
 * - Windows: `\\.\pipe\steam-client.token.<USERNAME>` — Named Pipes are
 *   per-session by default; pipe name with username keeps things isolated
 *   on multi-user terminal-server boxes.
 */
export function ipcSocketPath(): string {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME ?? 'default';
    return `\\\\.\\pipe\\steam-client.token.${user}`;
  }
  const user = os.userInfo().username || 'default';
  return path.join(os.tmpdir(), `steam-client.token.${user}.sock`);
}

/**
 * Start the IPC server. Resolves once `listen` fires (i.e. it is safe for
 * the native messaging host to connect). Failure is fatal-ish: we log and
 * reject — the extension simply won't get a token, the local server will
 * 401 every request, and the popup will show "offline".
 */
export function startTokenIpcServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const sockPath = ipcSocketPath();

    // POSIX: clean up any stale socket file from a previous crash. Without
    // this `listen` would EADDRINUSE — same logic Express/IPC libs use.
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(sockPath);
      } catch {
        /* not present, fine */
      }
    }

    const server = net.createServer((conn) => {
      // Single-shot protocol: respond once, then close. We don't even
      // parse the inbound bytes — any read triggers a token send.
      conn.once('data', () => {
        try {
          conn.end(JSON.stringify({ token: getServerToken() }) + '\n');
        } catch (err) {
          log.warn('[token-ipc] write failed', err);
          try {
            conn.destroy();
          } catch {}
        }
      });
      conn.on('error', (err) => log.warn('[token-ipc] client conn error', err));
    });

    server.on('error', (err) => {
      log.error('[token-ipc] listen error', err);
      reject(err);
    });

    server.listen(sockPath, () => {
      // POSIX-only: lock down the socket to the owning user. Without this
      // any local user could read the token via the socket. Best-effort —
      // tmpfs may not honour it on every platform/OS.
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(sockPath, 0o600);
        } catch (err) {
          log.warn('[token-ipc] chmod sock failed', err);
        }
      }
      ipcServer = server;
      log.info('[token-ipc] listening on', sockPath);
      resolve();
    });
  });
}

/** Tear the IPC server down. Called from `before-quit`. */
export function stopTokenIpcServer(): void {
  if (!ipcServer) return;
  try {
    ipcServer.close();
  } catch {}
  ipcServer = null;
  // POSIX: remove the socket file so a re-launch can rebind cleanly.
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(ipcSocketPath());
    } catch {
      /* may have been gone */
    }
  }
}
