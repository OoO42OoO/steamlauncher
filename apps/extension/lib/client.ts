import {
  SERVER_BASE,
  SERVER_PORT,
  getServerToken,
  invalidateServerToken,
} from './config';
import type { SiteTimeReport } from '@steam-client/shared';

/**
 * Authenticated fetch against the local desktop server. The bearer token
 * is fetched lazily from the desktop app via Chrome's Native Messaging.
 * On 401 we drop the cached token and retry once — that covers the
 * "desktop app restarted between requests" race.
 */
async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const doRequest = async (token: string): Promise<Response> =>
    fetch(`${SERVER_BASE}${path}`, {
      ...init,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

  let token: string;
  try {
    token = await getServerToken();
  } catch (err) {
    // Bubble as a synthetic 401 so callers can distinguish "couldn't even
    // fetch a token" from "server reachable but rejected" via the body.
    return new Response(
      JSON.stringify({ error: 'no_token', detail: (err as Error).message }),
      { status: 401, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let res = await doRequest(token);
  if (res.status === 401) {
    invalidateServerToken();
    try {
      token = await getServerToken();
      res = await doRequest(token);
    } catch {
      // Fall through with the original 401.
    }
  }
  return res;
}

export async function reportSiteTime(body: SiteTimeReport): Promise<boolean> {
  try {
    const r = await authFetch('/site-time', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export async function ping(): Promise<boolean> {
  try {
    const r = await fetch(`${SERVER_BASE}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

export function openBalanceWebSocket(
  onBalance: (seconds: number) => void,
  onStatus: (connected: boolean) => void
): () => void {
  let ws: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  async function connect(): Promise<void> {
    if (closed) return;
    let token: string;
    try {
      token = await getServerToken();
    } catch {
      onStatus(false);
      if (!closed) retryTimer = setTimeout(() => void connect(), 2000);
      return;
    }
    try {
      ws = new WebSocket(
        `ws://127.0.0.1:${SERVER_PORT}/ws?token=${encodeURIComponent(token)}`
      );
      ws.onopen = () => onStatus(true);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg?.type === 'balance' && typeof msg.seconds === 'number') {
            onBalance(msg.seconds);
          }
        } catch {}
      };
      ws.onclose = (ev) => {
        onStatus(false);
        // 1008 = unauthorized — token may be stale (desktop restarted),
        // drop the cached value before the next reconnect attempt.
        if (ev.code === 1008) invalidateServerToken();
        if (!closed) retryTimer = setTimeout(() => void connect(), 2000);
      };
      ws.onerror = () => {
        try {
          ws?.close();
        } catch {}
      };
    } catch {
      onStatus(false);
      if (!closed) retryTimer = setTimeout(() => void connect(), 2000);
    }
  }

  void connect();
  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    ws?.close();
  };
}
