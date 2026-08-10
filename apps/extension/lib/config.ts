// Local server where the desktop client is running.
//
// The token used to be hardcoded ('dev-token-change-me'). It is now
// delivered out-of-band via Chrome's Native Messaging API: at startup the
// extension calls `chrome.runtime.sendNativeMessage(NATIVE_HOST, ...)` and
// receives the live ephemeral token that the desktop main process
// generated on app launch. The token rotates every time the desktop app
// restarts.
//
// Cache the token in module-level memory of the service worker. On 401
// from the local server, callers should `invalidateServerToken()` and
// re-fetch — that handles desktop-restart races.
export const SERVER_PORT = 38721;
export const SERVER_BASE = `http://127.0.0.1:${SERVER_PORT}`;
export const NATIVE_HOST = 'com.steam_client.token';

let cachedToken: string | null = null;
let inflight: Promise<string> | null = null;

interface NativeResponse {
  ok?: boolean;
  token?: string;
  error?: string;
}

export function invalidateServerToken(): void {
  cachedToken = null;
}

export async function getServerToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  if (inflight) return inflight;
  inflight = new Promise<string>((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(
        NATIVE_HOST,
        { cmd: 'get_token' },
        (response: NativeResponse | undefined) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message ?? 'native messaging failed'));
            return;
          }
          if (!response || !response.ok || !response.token) {
            reject(new Error(response?.error ?? 'no token in response'));
            return;
          }
          cachedToken = response.token;
          resolve(response.token);
        }
      );
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // Ignore hash + trailing slash. Query kept (some sites rely on it).
    return (u.origin + u.pathname).replace(/\/$/, '');
  } catch {
    return raw;
  }
}
